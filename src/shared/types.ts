import type { Dir } from "./layout";

/** Distinct from the original plugin so both can be installed side by side (only one enabled). */
export const VIEW_TYPE_MIND_MAP = "obsimap-custom-view";

export type MindMapLayoutMode = "outline" | "radial";

/** Node colours, mapped to Obsidian's theme palette (`--color-<name>-rgb`). */
export const NODE_COLORS = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink"] as const;
export type NodeColor = (typeof NODE_COLORS)[number];
export const NODE_COLOR_LABELS: Record<NodeColor, string> = {
    red: "Red",
    orange: "Orange",
    yellow: "Yellow",
    green: "Green",
    cyan: "Cyan",
    blue: "Blue",
    purple: "Purple",
    pink: "Pink",
};

export interface MindMapSettings {
    exportFolder: string;
    theme: string;
    hotkeys: {
        addChild: string;
        addSibling: string;
        delete: string;
        rename: string;
        reorderUp: string;
        reorderDown: string;
        promote: string;
        demote: string;
        searchNote: string;
        createNote: string;
        openNote: string;
        toggleCollapse: string;
        changeColor: string;
    };
    stripMetadata: boolean;
    showHoverPreview: boolean;
    maxNodeLength: number;
    /** Wrap node text after this many characters per line; 0 = never wrap. */
    wrapLength: number;
    /** Never truncate node text (wraps onto as many lines as needed). */
    showFullText: boolean;
    nodeStyle: "pill" | "rect";
    /** Outline = rightward list tree; radial = classic left/right mind map. */
    layoutMode: MindMapLayoutMode;
    /** Colours used for image export. */
    exportTheme: "current" | "light" | "dark";
    /** PNG / SVG without background. */
    exportTransparent: boolean;
    /** PNG resolution multiplier. */
    exportScale: number;
}

export const DEFAULT_SETTINGS: MindMapSettings = {
    exportFolder: "",
    theme: "default",
    hotkeys: {
        addChild: "Tab",
        addSibling: "Enter",
        delete: "Delete",
        rename: "Shift+Enter",
        reorderUp: "Shift+ArrowUp",
        reorderDown: "Shift+ArrowDown",
        promote: "Shift+ArrowLeft",
        demote: "Shift+ArrowRight",
        searchNote: "Shift+Ctrl+Enter",
        createNote: "Ctrl+Shift+N",
        openNote: "Ctrl+Shift+L",
        toggleCollapse: "Ctrl+/",
        changeColor: "Ctrl+Shift+K",
    },
    stripMetadata: true,
    showHoverPreview: true,
    maxNodeLength: 20,
    wrapLength: 30,
    showFullText: true,
    nodeStyle: "pill",
    layoutMode: "outline",
    exportTheme: "current",
    exportTransparent: false,
    exportScale: 2,
};

export interface MindMapNode {
    id: string;
    text: string;
    children: MindMapNode[];
    parent?: string;
    x?: number;
    y?: number;
    collapsed?: boolean;
    /** Side of the root for radial layout; only used for direct children of root. */
    side?: "left" | "right";
    /** Side of this node relative to its parent (north/south/east/west); inherited when unset. */
    dir?: Dir;
    /** Chip colour. */
    color?: NodeColor;
}
