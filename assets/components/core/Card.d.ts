import * as React from "react";

export interface CardProps {
  children?: React.ReactNode;
  /** Lift one focused card with the expressive glow. Default none. */
  glow?: "none" | "honey" | "pollinate";
  padding?: number;
  /** Brighten the border on hover. */
  interactive?: boolean;
  style?: React.CSSProperties;
}

/** Surface card — bg.elevated, 1px border, 12px radius, no shadow. */
export function Card(props: CardProps): JSX.Element;
