"""Phase 7 sentiment classification via the Claude API (official Anthropic Python SDK).

Sends a player's recent headlines to Claude and gets back a structured judgement:
overall sentiment, topic tags, a minutes_risk_adj in [-1, 0] (how much the news lowers the
chance this player starts the next match), and a one-line summary a manager can act on.

We use Haiku — this is high-volume, low-difficulty classification, so the cheapest/fastest
model is the right call. A single *forced tool call* gives a reliably-shaped result without
depending on the newest structured-outputs surface.

Per CLAUDE.md, sentiment is an ADVISORY signal: the chip + minutes_risk_adj are surfaced in
the UI but NOT folded into the headline xPts model until backtested.

Requires ANTHROPIC_API_KEY in the environment (worker/.env).
"""

from __future__ import annotations

import os

import anthropic

MODEL = "claude-haiku-4-5"

TOPICS = [
    "injury-risk",
    "return-from-injury",
    "rotation",
    "suspension",
    "form-buzz",
    "transfer",
    "off-pitch",
    "none",
]

SYSTEM = (
    "You are an assistant for a Fantasy Premier League decision tool. Given recent news "
    "headlines about a specific Premier League footballer, judge what the news means for that "
    "player's FPL value over the next gameweek. Only consider headlines that are clearly about "
    "THIS player (the named footballer at the named club). Ignore headlines about other people "
    "who share the name, or about unrelated topics. If none of the headlines are clearly "
    "relevant, record sentiment 'neutral', topics ['none'], minutes_risk_adj 0, and say there "
    "is no relevant recent news. Always answer by calling the record_sentiment tool."
)

TOOL = {
    "name": "record_sentiment",
    "description": "Record the FPL-relevant sentiment analysis of a player's recent news.",
    "input_schema": {
        "type": "object",
        "properties": {
            "sentiment": {
                "type": "string",
                "enum": ["positive", "neutral", "negative", "mixed"],
                "description": "Overall tone of the news for this player's near-term FPL value.",
            },
            "topics": {
                "type": "array",
                "items": {"type": "string", "enum": TOPICS},
                "description": (
                    "The relevant themes. Use 'injury-risk' for a knock/doubt, "
                    "'return-from-injury' for a comeback, 'rotation' for benching/squad-depth "
                    "risk, 'form-buzz' for hot form or hype, 'transfer' for move rumours, "
                    "'off-pitch' for non-football news, or 'none' if nothing is relevant."
                ),
            },
            "minutes_risk_adj": {
                "type": "number",
                "description": (
                    "How much the news lowers this player's chance of starting the next match: "
                    "0.0 = no impact, -0.3 = a real doubt, -1.0 = almost certainly will not play. "
                    "Must be 0 or negative."
                ),
            },
            "summary": {
                "type": "string",
                "description": "One concise sentence a manager can act on, reflecting what the news actually says.",
            },
        },
        "required": ["sentiment", "topics", "minutes_risk_adj", "summary"],
    },
}


def get_client() -> anthropic.Anthropic:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise RuntimeError(
            "ANTHROPIC_API_KEY must be set to run the news/sentiment job "
            "(see worker/.env.example)."
        )
    return anthropic.Anthropic()


def classify(
    client: anthropic.Anthropic,
    web_name: str,
    team_name: str | None,
    headlines: list,
    model: str = MODEL,
) -> dict | None:
    """Return {sentiment, topics, minutes_risk_adj, summary} or None on refusal/error."""
    lines = []
    for h in headlines:
        when = h.published_at.date().isoformat() if h.published_at else "date unknown"
        src = f" — {h.source}" if h.source else ""
        lines.append(f"- ({when}{src}) {h.title}")
    body = "\n".join(lines)
    club = f" ({team_name})" if team_name else ""
    user = (
        f"Player: {web_name}{club}\n\n"
        f"Recent headlines:\n{body}\n\n"
        "Analyse these and call record_sentiment."
    )

    try:
        resp = client.messages.create(
            model=model,
            max_tokens=512,
            system=SYSTEM,
            tools=[TOOL],
            tool_choice={"type": "tool", "name": "record_sentiment"},
            messages=[{"role": "user", "content": user}],
        )
    except anthropic.APIError as exc:
        print(f"    classify failed for {web_name!r}: {exc}")
        return None

    if resp.stop_reason == "refusal":
        return None
    for block in resp.content:
        if block.type == "tool_use" and block.name == "record_sentiment":
            return _normalize(block.input)
    return None


def _normalize(raw: dict) -> dict:
    topics = [t for t in (raw.get("topics") or []) if t in TOPICS] or ["none"]
    adj = raw.get("minutes_risk_adj", 0.0)
    try:
        adj = max(-1.0, min(0.0, float(adj)))  # advisory signal is clamped to [-1, 0]
    except (TypeError, ValueError):
        adj = 0.0
    sentiment = raw.get("sentiment") if raw.get("sentiment") in (
        "positive", "neutral", "negative", "mixed"
    ) else "neutral"
    return {
        "sentiment": sentiment,
        "topics": topics,
        "minutes_risk_adj": adj,
        "summary": (raw.get("summary") or "").strip(),
    }
