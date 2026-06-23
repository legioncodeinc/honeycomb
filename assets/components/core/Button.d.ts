import * as React from "react";

/**
 * The Honeycomb button. Honey primary is the single brand action per view.
 */
export interface ButtonProps {
  children?: React.ReactNode;
  /** Visual intent. Honey is the one brand action (scarcity rule). */
  variant?: "primary" | "secondary" | "ghost" | "pollinate" | "danger";
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  type?: "button" | "submit" | "reset";
  style?: React.CSSProperties;
}

export function Button(props: ButtonProps): JSX.Element;
