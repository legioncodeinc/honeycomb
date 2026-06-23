import * as React from "react";

/**
 * The signature Honeycomb surface: one recalled or stored memory cell.
 */
export interface MemoryCardProps {
  /** The memory key / id, shown in mono in the accent color. */
  memoryKey: string;
  /** The recalled snippet of memory text. */
  snippet: React.ReactNode;
  /** Provenance — file path, session id, or source the memory came from. */
  source?: string;
  /** Relevance score 0–1 (rendered to 2 dp). */
  score?: number;
  /** Visibility scope. */
  scope?: "personal" | "team" | "org";
  /** Source-backed memory — renders the green verified state. */
  verified?: boolean;
  /** Currently being consolidated by the Pollinating loop — violet pulse. */
  pollinating?: boolean;
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  style?: React.CSSProperties;
}

export function MemoryCard(props: MemoryCardProps): JSX.Element;
