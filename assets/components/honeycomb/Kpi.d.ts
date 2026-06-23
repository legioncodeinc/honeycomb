import * as React from "react";

export interface KpiProps {
  label: string;
  value: string | number;
  unit?: string;
  /** Optional week-over-week delta; positive = green up, negative = red down. */
  delta?: number;
  accent?: "honey" | "pollinate" | "verified" | "neutral";
  style?: React.CSSProperties;
}

/** Dashboard metric tile — one big mono value with label and optional delta. */
export function Kpi(props: KpiProps): JSX.Element;
