-- FPL Player Selector — initial schema (spec §9).
-- Full schema is created now so later phases don't churn migrations; Phase 0-1 only
-- populates teams, players, fixtures. All *_id columns that come from the FPL API use the
-- FPL entity id as the natural primary key so worker upserts are idempotent.

-- ---------------------------------------------------------------------------
-- teams (FPL bootstrap-static -> teams[])
-- ---------------------------------------------------------------------------
create table if not exists teams (
    fpl_id                 integer primary key,     -- teams[].id (1..20 this season)
    code                   integer,                 -- stable cross-season code
    name                   text not null,
    short_name             text not null,
    strength               integer,
    strength_overall_home  integer,
    strength_overall_away  integer,
    strength_attack_home   integer,
    strength_attack_away   integer,
    strength_defence_home  integer,
    strength_defence_away  integer,
    elo                    numeric                  -- reserved for Phase 2 (ClubElo)
);

-- ---------------------------------------------------------------------------
-- players (FPL bootstrap-static -> elements[])
-- ---------------------------------------------------------------------------
create table if not exists players (
    fpl_id                             integer primary key,   -- elements[].id
    code                               integer,
    web_name                           text not null,
    first_name                         text,
    second_name                        text,
    full_name                          text,
    team_id                            integer references teams(fpl_id),
    element_type                       integer,               -- 1..4
    position                           text,                  -- GK/DEF/MID/FWD
    now_cost                           integer,               -- tenths of a million
    status                             text,                  -- a/d/i/s/u/n
    chance_of_playing_this_round       integer,
    chance_of_playing_next_round       integer,
    news                               text,
    news_added                         timestamptz,
    form                               numeric,
    selected_by_percent                numeric,
    ict_index                          numeric,
    minutes                            integer,
    total_points                       integer,
    expected_goals                     numeric,
    expected_assists                   numeric,
    expected_goal_involvements         numeric,
    expected_goals_conceded            numeric,
    expected_goals_per_90              numeric,
    expected_assists_per_90            numeric,
    expected_goal_involvements_per_90  numeric,
    -- crosswalk keys (Phase 2) + set-piece flags
    understat_id                       text,
    fbref_id                           text,
    is_penalty_taker                   boolean default false,
    is_setpiece_taker                  boolean default false
);
create index if not exists players_team_id_idx on players(team_id);
create index if not exists players_position_idx on players(position);

-- ---------------------------------------------------------------------------
-- fixtures (FPL /fixtures/)
-- ---------------------------------------------------------------------------
create table if not exists fixtures (
    fpl_id             integer primary key,   -- fixtures[].id
    gw                 integer,               -- event; null if unscheduled
    team_h             integer references teams(fpl_id),
    team_a             integer references teams(fpl_id),
    team_h_difficulty  integer,
    team_a_difficulty  integer,
    kickoff_time       timestamptz,
    finished           boolean default false,
    -- Phase 2 data-driven FDR + DGW/BGW flags
    custom_fdr_h       numeric,
    custom_fdr_a       numeric,
    is_dgw             boolean default false,
    is_bgw             boolean default false
);
create index if not exists fixtures_gw_idx on fixtures(gw);

-- ---------------------------------------------------------------------------
-- Downstream tables — created now, populated in their phase (empty for the first win).
-- ---------------------------------------------------------------------------
create table if not exists player_gw_stats (
    player_id       integer references players(fpl_id),
    gw              integer,
    minutes         integer,
    xg              numeric,
    xa              numeric,
    xgi             numeric,
    npxg            numeric,
    shots           integer,
    sca             numeric,
    defcon_actions  integer,
    bps             integer,
    points          integer,
    price           integer,
    ownership_pct   numeric,
    primary key (player_id, gw)
);

create table if not exists projections (
    player_id      integer references players(fpl_id),
    gw             integer,
    x_pts          numeric,
    p_start        numeric,
    exp_minutes    numeric,
    x_goals_pts    numeric,
    x_assist_pts   numeric,
    x_cs_pts       numeric,
    x_bonus_pts    numeric,
    x_defcon_pts   numeric,
    fixture_adj    numeric,
    sentiment_adj  numeric,
    model_version  text,
    generated_at   timestamptz default now(),
    primary key (player_id, gw, model_version)
);

create table if not exists prices (
    player_id       integer references players(fpl_id),
    gw              integer,
    price           integer,
    net_transfers   integer,
    price_momentum  numeric,
    primary key (player_id, gw)
);

create table if not exists news_sentiment (
    id               bigint generated always as identity primary key,
    player_id        integer references players(fpl_id),
    source           text,
    url              text,
    published_at     timestamptz,
    sentiment        text,
    topics           text[],
    summary          text,
    minutes_risk_adj numeric
);

create table if not exists user_team_state (
    user_id          text,
    fpl_entry_id     integer,
    gw               integer,
    bank             integer,
    team_value       integer,
    free_transfers   integer,
    chips_available  text[],
    picks            jsonb,
    rank             integer,
    primary key (user_id, gw)
);

create table if not exists optimizer_runs (
    id              bigint generated always as identity primary key,
    user_id         text,
    gw              integer,
    horizon         integer,
    objective       text,
    suggested_squad jsonb,
    transfers       jsonb,
    chip_reco       text,
    captain_id      integer,
    expected_gain   numeric,
    created_at      timestamptz default now()
);

-- crosswalk stub: fpl_id <-> understat_id <-> fbref_id (resolved in Phase 2)
create table if not exists crosswalk (
    fpl_id       integer primary key references players(fpl_id),
    understat_id text,
    fbref_id     text,
    confidence   numeric,
    verified     boolean default false
);
