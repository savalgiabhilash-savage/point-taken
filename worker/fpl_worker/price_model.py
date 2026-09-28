"""Price-change signal (accuracy plan factor 20).

FPL moves prices daily from net transfers since each player's last change; only weekly totals are free,
so this is a coarse signal. pressure = net transfers this GW / number of owners. The chance of a rise or
fall before the next deadline for each pressure band was measured on 2023-24 and 2024-25 (vaastav
dataset: next GW's price vs this GW's transfer balance). It is shown to the user, not used by the
optimizer: even heavy buying gives under a 20% chance of a rise, and a £0.1m change is worth a fraction
of a point, so it shouldn't move a transfer decision.
"""

from __future__ import annotations

# (upper bound of pressure band, P(rise), P(fall)) — from the backtest data, bands ordered low -> high
TABLE = [
    (-0.5, 0.000, 0.347),
    (-0.2, 0.006, 0.279),
    (-0.1, 0.003, 0.236),
    (-0.05, 0.007, 0.109),
    (-0.02, 0.003, 0.058),
    (0.02, 0.007, 0.017),
    (0.05, 0.051, 0.007),
    (0.1, 0.094, 0.006),
    (0.2, 0.137, 0.005),
    (0.5, 0.171, 0.002),
    (float("inf"), 0.185, 0.005),
]


def price_signal(transfers_in: int, transfers_out: int, owned_pct: float, total_managers: int) -> dict:
    owners = owned_pct / 100.0 * total_managers
    net = transfers_in - transfers_out
    pressure = net / owners if owners >= 1000 else 0.0  # tiny ownership: too noisy to say anything
    for upper, p_rise, p_fall in TABLE:
        if pressure <= upper:
            return {"net": net, "pressure": round(pressure, 4), "p_rise": p_rise, "p_fall": p_fall}
    return {"net": net, "pressure": 0.0, "p_rise": 0.0, "p_fall": 0.0}
