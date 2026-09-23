import type { GraphTheme } from '@memnest/ui-core';

export type ThemeName = 'light' | 'dark';

const shared = { supersededAlpha: 0.35, forgottenAlpha: 0.6, font: '12px system-ui, -apple-system, "Segoe UI", sans-serif' };

/** The dashboard's graph palettes (apps/dashboard/src/styles.css), so the graph looks the same in both places. */
export const GRAPH_THEMES: Record<ThemeName, GraphTheme> = {
  light: {
    ...shared,
    ground: 'light',
    background: '#fbfcff',
    spark: '#4c46c8',
    kinds: { fact: '#1f84cf', preference: '#e46f27', episode: '#11a06a' },
    cluster: '#a3adf2',
    clusterStroke: '#6570cf',
    edges: { updates: '#5c61b3', extends: '#7d6fe0', aggregate: '#8f9bd8' },
    label: '#1a2042',
    labelHalo: 'rgba(251, 252, 255, 0.92)',
    selection: '#0f1430',
    lineage: '#d6339b',
  },
  dark: {
    ...shared,
    ground: 'dark',
    background: '#060913',
    spark: '#ffffff',
    kinds: { fact: '#4cc6ff', preference: '#ffae45', episode: '#44f5a8' },
    cluster: '#8ea6ff',
    clusterStroke: '#c7d3ff',
    edges: { updates: '#a9b9ff', extends: '#8b7bff', aggregate: '#7d93e0' },
    label: '#e6ecff',
    labelHalo: 'rgba(6, 9, 19, 0.9)',
    selection: '#ffffff',
    lineage: '#ff6ad5',
  },
};

export function systemTheme(): ThemeName {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
