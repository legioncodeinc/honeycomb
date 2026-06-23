import * as React from "react";

export interface BadgeProps {
  children?: React.ReactNode;
  /** Maps to the semantic palette. `verified` = source-backed green. */
  tone?: "neutral" | "honey" | "verified" | "pollinate" | "info" | "warning" | "critical";
  /** Render the label in JetBrains Mono (for ids / counts / states). */
  mono?: boolean;
  /** Leading status dot in the tone color. */
  dot?: boolean;
  style?: React.CSSProperties;
}

/** Compact status pill for memory & session states. */
export function Badge(props: BadgeProps): JSX.Element;
