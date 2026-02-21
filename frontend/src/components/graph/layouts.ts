/**
 * Cytoscape layout configurations.
 */
import type { Core } from "cytoscape";

export type LayoutName = "fcose" | "dagre";

export const LAYOUT_FCOSE = {
    name: "fcose",
    animate: true,
    animationDuration: 500,
    randomize: false,
    nodeDimensionsIncludeLabels: true,
    idealEdgeLength: 120,
    nodeRepulsion: 5500,
    gravity: 0.2,
} as const;

export const LAYOUT_FCOSE_INITIAL = {
    ...LAYOUT_FCOSE,
    animationDuration: 600,
    animationEasing: "ease-out-cubic",
    randomize: true,
} as const;

export const LAYOUT_DAGRE = {
    name: "dagre",
    animate: true,
    animationDuration: 500,
    rankDir: "LR",
    spacingFactor: 1.2,
    nodeDimensionsIncludeLabels: true,
} as const;

export function runLayout(cy: Core, name: LayoutName): void {
    const config = name === "fcose" ? LAYOUT_FCOSE : LAYOUT_DAGRE;
    cy.layout(config as any).run();
}
