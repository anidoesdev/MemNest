export interface LayoutNode {
  id: string;
  /** Radius, for collision. Default 6. */
  r?: number;
}

export interface LayoutEdge {
  from: string;
  to: string;
}
