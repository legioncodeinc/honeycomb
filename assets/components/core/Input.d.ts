import * as React from "react";

export interface InputProps {
  value?: string;
  defaultValue?: string;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  /** Render the value in JetBrains Mono — for keys, queries, ids, paths. */
  mono?: boolean;
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  iconLeft?: React.ReactNode;
  type?: string;
  style?: React.CSSProperties;
}

/** Text input; focus lights the honey ring. */
export function Input(props: InputProps): JSX.Element;
