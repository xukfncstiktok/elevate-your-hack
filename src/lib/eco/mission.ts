import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import {
  INTERVENTIONS,
  REGION_SEEDS,
  THREAT_LABEL,
  type InterventionId,
  type RegionSeed,
} from "./regions";

export interface RegionState extends RegionSeed {
  /** 0-1 active mitigation coverage, decays over time */
  mitigation: number;
  /** cumulative Mt CO2e secured in this region */
  secured: number;
  /** last deployed intervention id */
  lastAction?: InterventionId;
  flash: number;
}

export interface MissionEvent {
  id: number;
  tick: number;
  level: "info" | "good" | "warn" | "crit";
  source: string;
  text: string;
}

export interface MissionState {
  tick: number;
  running: boolean;
  credits: number;
  maxCredits: number;
  regions: RegionState[];
  cooldowns: Record<InterventionId, number>;
  events: MissionEvent[];
  selected: string;
  carbonSecured: number;
  deployments: number;
  matched: number;
  history: { t: number; health: number; carbon: number }[];
  eventSeq: number;
}

export type Status = "stable" | "strained" | "critical";

export function statusOf(health: number): Status {
  if (health >= 70) return "stable";
  if (health >= 45) return "strained";
  return "critical";
}

export function globalHealth(regions: RegionState[]) {
  const w = regions.reduce((a, r) => a + r.carbonAtRisk, 0);
  return regions.reduce((a, r) => a + r.health * r.carbonAtRisk, 0) / w;
}

const CLOCK_START = 6 * 3600;

export function missionClock(tick: number) {
  const t = CLOCK_START + tick * 137;
  const h = Math.floor(t / 3600) % 24;
  const m = Math.floor(t / 60) % 60;
  const s = t % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

function init(): MissionState {
  return {
    tick: 0,
    running: true,
    credits: 60,
    maxCredits: 120,
    regions: REGION_SEEDS.map((r) => ({ ...r, mitigation: 0, secured: 0, flash: 0 })),
    cooldowns: { drone: 0, grid: 0, corridor: 0, cloud: 0 },
    events: [
      {
        id: 0,
        tick: 0,
        level: "info",
        source: "ORBIT",
        text: "Constellation handshake complete — 12 sentinel regions streaming.",
      },
    ],
    selected: "amazon",
    carbonSecured: 0,
    deployments: 0,
    matched: 0,
    history: [],
    eventSeq: 1,
  };
}

type Action =
  | { type: "tick" }
  | { type: "select"; id: string }
  | { type: "deploy"; intervention: InterventionId }
  | { type: "toggle" }
  | { type: "reset" };

function pushEvent(s: MissionState, e: Omit<MissionEvent, "id" | "tick">): MissionState {
  const event: MissionEvent = { ...e, id: s.eventSeq, tick: s.tick };
  return { ...s, eventSeq: s.eventSeq + 1, events: [event, ...s.events].slice(0, 60) };
}

const INCIDENTS: Record<string, string[]> = {
  deforestation: [
    "New clearing signature detected by SAR pass",
    "Logging road extended 4.2 km overnight",
    "Canopy density down 1.8% in sector scan",
  ],
  emissions: [
    "Methane plume flagged over industrial node",
    "Evening peak fell back to fossil baseload",
    "NO₂ column density above regional cap",
  ],
  drought: [
    "Soil moisture index dropped below wilting point",
    "Reservoir inflow at 31% of seasonal median",
    "Evapotranspiration anomaly widening",
  ],
  reefBleaching: [
    "Degree-heating-week accumulation rising",
    "Fluorescence survey shows early paling",
    "Sea surface anomaly sustained +1.9 °C",
  ],
  permafrost: [
    "Thaw slump expanded along river terrace",
    "Active layer probe reads +6 cm this cycle",
    "Methane flux doubled at monitoring mast",
  ],
};

function reducer(state: MissionState, action: Action): MissionState {
  switch (action.type) {
    case "toggle":
      return { ...state, running: !state.running };
    case "reset":
      return init();
    case "select":
      return { ...state, selected: action.id };
    case "tick": {
      const tick = state.tick + 1;
      const escalation = 1 + tick / 260;
      const regions = state.regions.map((r) => {
        const mitigation = Math.max(0, r.mitigation * 0.93);
        const loss = r.pressure * escalation * (1 - Math.min(0.92, mitigation));
        const gain = mitigation * 2.7;
        const health = Math.max(4, Math.min(100, r.health + gain - loss));
        const secured = r.secured + (mitigation * r.carbonAtRisk) / 90;
        return { ...r, mitigation, health, secured, flash: Math.max(0, r.flash - 1) };
      });
      const carbonSecured = regions.reduce((a, r) => a + r.secured, 0);
      let next: MissionState = {
        ...state,
        tick,
        regions,
        carbonSecured,
        credits: Math.min(state.maxCredits, state.credits + 3.5),
        cooldowns: {
          drone: Math.max(0, state.cooldowns.drone - 1),
          grid: Math.max(0, state.cooldowns.grid - 1),
          corridor: Math.max(0, state.cooldowns.corridor - 1),
          cloud: Math.max(0, state.cooldowns.cloud - 1),
        },
        history: [
          ...state.history,
          { t: tick, health: globalHealth(regions), carbon: carbonSecured },
        ].slice(-70),
      };

      if (tick % 6 === 0) {
        const pool = next.regions.filter((r) => r.mitigation < 0.3);
        const target = (pool.length ? pool : next.regions)[
          Math.floor(Math.random() * (pool.length || next.regions.length))
        ];
        const lines = INCIDENTS[target.threat];
        const text = lines[Math.floor(Math.random() * lines.length)];
        next = {
          ...next,
          regions: next.regions.map((r) =>
            r.id === target.id
              ? { ...r, health: Math.max(4, r.health - 2.5), flash: 3 }
              : r,
          ),
        };
        next = pushEvent(next, {
          level: statusOf(target.health) === "critical" ? "crit" : "warn",
          source: target.code,
          text: `${text} — ${target.name}`,
        });
      }
      return next;
    }
    case "deploy": {
      const plan = INTERVENTIONS.find((i) => i.id === action.intervention)!;
      const region = state.regions.find((r) => r.id === state.selected)!;
      if (state.cooldowns[plan.id] > 0 || state.credits < plan.cost) return state;
      const matched = plan.counters.includes(region.threat);
      const bump = matched ? plan.power * 0.55 : plan.power * 0.16;
      const cover = matched ? 0.85 : 0.3;
      let next: MissionState = {
        ...state,
        credits: state.credits - plan.cost,
        deployments: state.deployments + 1,
        matched: state.matched + (matched ? 1 : 0),
        cooldowns: { ...state.cooldowns, [plan.id]: plan.cooldown },
        regions: state.regions.map((r) =>
          r.id === region.id
            ? {
                ...r,
                health: Math.min(100, r.health + bump),
                mitigation: Math.min(1, r.mitigation + cover),
                lastAction: plan.id,
                flash: 4,
              }
            : r,
        ),
      };
      next = pushEvent(next, {
        level: matched ? "good" : "warn",
        source: region.code,
        text: matched
          ? `${plan.name} deployed over ${region.name} — countermeasure matched to ${THREAT_LABEL[region.threat].toLowerCase()}.`
          : `${plan.name} deployed over ${region.name} — poor fit for ${THREAT_LABEL[region.threat].toLowerCase()}, minimal yield.`,
      });
      return next;
    }
    default:
      return state;
  }
}

export function useMission() {
  const [state, dispatch] = useReducer(reducer, undefined, init);
  const runningRef = useRef(state.running);
  runningRef.current = state.running;

  useEffect(() => {
    const id = setInterval(() => {
      if (runningRef.current) dispatch({ type: "tick" });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const selected = state.regions.find((r) => r.id === state.selected)!;
  const health = useMemo(() => globalHealth(state.regions), [state.regions]);
  const advisory = useMemo(() => {
    const ranked = [...state.regions].sort(
      (a, b) =>
        a.health - a.mitigation * 30 - (b.health - b.mitigation * 30),
    );
    const target = ranked[0];
    const plan = INTERVENTIONS.find((i) => i.counters.includes(target.threat))!;
    return { target, plan };
  }, [state.regions]);

  const criticals = state.regions.filter((r) => statusOf(r.health) === "critical").length;
  const covered = state.regions.filter((r) => r.mitigation > 0.25).length;

  return {
    state,
    selected,
    health,
    advisory,
    criticals,
    covered,
    select: useCallback((id: string) => dispatch({ type: "select", id }), []),
    deploy: useCallback((i: InterventionId) => dispatch({ type: "deploy", intervention: i }), []),
    toggle: useCallback(() => dispatch({ type: "toggle" }), []),
    reset: useCallback(() => dispatch({ type: "reset" }), []),
  };
}
