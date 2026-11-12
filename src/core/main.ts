import {
    Plugin,
    PluginSettingTab,
    FuzzySuggestModal,
    Modal,
    Menu,
    setIcon,
    setTooltip,
    Notice,
    TFile,
    TFolder,
    Setting,
    TextComponent,
    WorkspaceLeaf,
    App,
    MetadataCache,
    TextFileView,
} from "obsidian";
import {
    VIEW_TYPE_MIND_MAP,
    MindMapSettings,
    DEFAULT_SETTINGS,
    MindMapNode,
    NODE_COLORS,
    NODE_COLOR_LABELS,
    NodeColor,
} from "../shared/types";
import {
    DIRS,
    Dir,
    DisplayText,
    FIRST_BASELINE,
    LINE_HEIGHT,
    Size,
    TextOptions,
    anchor,
    blockedDir,
    connectorPath,
    displayText,
    hitPole,
    inheritedDir,
    layoutTree,
    poleCenter,
    reorientSubtree,
    sizeOfLines,
} from "../shared/layout";

import { ExportFormat, ExportedSvg, rasterPdf, rasterize, vectorPdf } from "./export";

type DropMode = "child" | "above" | "below" | "replace";

/** Computed styles copied onto exported elements (CSS classes and theme variables don't travel). */
const EXPORT_STYLE_PROPS = [
    "fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray",
    "stroke-linecap", "stroke-linejoin", "opacity", "font-family", "font-size", "font-weight",
    "font-style", "letter-spacing", "text-decoration-line", "text-decoration-color",
    "text-decoration-style", "text-decoration-thickness", "text-underline-offset",
];

const DIR_LABELS: Record<Dir, string> = { n: "North (above)", e: "East (right)", s: "South (below)", w: "West (left)" };
const DIR_ICONS: Record<Dir, string> = { n: "arrow-up", e: "arrow-right", s: "arrow-down", w: "arrow-left" };
/** Narrow shape of Obsidian's internal (undocumented) `app.dragManager`. */
type DragMgr = {
    viewDragContext?: { file?: unknown };
    activeDrag?: { file?: unknown };
    draggable?: { file?: unknown };
};

/** Collect folders by walking the in-memory vault tree (avoids getAllLoadedFiles). */
function collectVaultFolders(root: TFolder): TFolder[] {
    const folders: TFolder[] = [];
    const walk = (folder: TFolder) => {
        folders.push(folder);
        for (const child of folder.children) {
            if (child instanceof TFolder) walk(child);
        }
    };
    walk(root);
    return folders;
}

/** Type-safe `JSON.parse` for persisted mindmap state; returns null on malformed input. */
function parseMindMapJson(json: string): { root: MindMapNode } | null {
    try {
        const parsed: unknown = JSON.parse(json);
        if (parsed && typeof parsed === "object" && "root" in parsed) {
            return parsed as { root: MindMapNode };
        }
        return null;
    } catch {
        return null;
    }
}

/** Collect markdown files under a folder via tree walk (avoids getMarkdownFiles). */
function collectMarkdownFilesInFolder(folder: TFolder): TFile[] {
    const files: TFile[] = [];
    const walk = (dir: TFolder) => {
        for (const child of dir.children) {
            if (child instanceof TFile && child.extension === "md") files.push(child);
            else if (child instanceof TFolder) walk(child);
        }
    };
    walk(folder);
    return files;
}

export default class MindMapPlugin extends Plugin {
    settings: MindMapSettings;
    isInternalRenaming = false;
    /** Paths of .mindmap files, kept in sync via vault events and layout-ready scan. */
    mindmapPaths = new Set<string>();

    async onload() {
        await this.loadSettings();

        this.registerView(
            VIEW_TYPE_MIND_MAP,
            (leaf) => new MindMapView(leaf, this)
        );

        this.registerExtensions(["mindmap"], VIEW_TYPE_MIND_MAP);
        this.registerHoverLinkSource(VIEW_TYPE_MIND_MAP, { display: "Simple Mindmap", defaultMod: true });

        this.addRibbonIcon("network", "Open mind map", () => {
            void this.activateView();
        });

        this.addSettingTab(new MindMapSettingTab(this.app, this));

        const exportCommand = (format: ExportFormat, label: string) =>
            this.addCommand({
                id: `export-${format}`,
                name: `Export mind map as ${label}`,
                checkCallback: (checking) => {
                    const view = this.app.workspace.getActiveViewOfType(MindMapView);
                    if (!view) return false;
                    if (!checking) void view.exportImage(format);
                    return true;
                },
            });
        exportCommand("svg", "SVG");
        exportCommand("png", "PNG");
        exportCommand("pdf", "PDF");

        this.addCommand({
            id: "import-markdown",
            name: "Import current note",
            callback: () => {
                const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_MIND_MAP);
                const view = leaves.length > 0 ? leaves[0].view : null;
                if (view instanceof MindMapView) {
                    void view.importMarkdown();
                } else {
                    void this.activateView().then(() => {
                        const newLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_MIND_MAP);
                        const newView = newLeaves.length > 0 ? newLeaves[0].view : null;
                        if (newView instanceof MindMapView) void newView.importMarkdown();
                    });
                }
            },
        });

        this.registerEvent(
            this.app.vault.on("rename", (file, oldPath) => {
                if (this.isInternalRenaming) return;
                if (file instanceof TFile && (file.extension === "md" || file.extension === "mindmap")) {
                    void this.handleFileRename(file, oldPath);
                }
            })
        );

        this.registerEvent(
            this.app.workspace.on("active-leaf-change", (leaf) => {
                if (leaf && leaf.view instanceof MindMapView) {
                    leaf.view.focusContainer();
                }
            })
        );

        this.registerEvent(
            this.app.vault.on("create", (file) => {
                if (file instanceof TFile && file.extension === "mindmap") {
                    this.mindmapPaths.add(file.path);
                }
            })
        );
        this.registerEvent(
            this.app.vault.on("delete", (file) => {
                if (file instanceof TFile && file.extension === "mindmap") {
                    this.mindmapPaths.delete(file.path);
                }
            })
        );
        this.registerEvent(
            this.app.vault.on("rename", (file, oldPath) => {
                if (file instanceof TFile && file.extension === "mindmap") {
                    this.mindmapPaths.delete(oldPath);
                    this.mindmapPaths.add(file.path);
                }
            })
        );

        this.app.workspace.onLayoutReady(() => {
            void this.refreshMindmapPaths();
        });
    }

    /** Discover .mindmap paths via adapter listing (no vault.getFiles). */
    async refreshMindmapPaths(): Promise<void> {
        const found = new Set<string>();
        await this.listMindmapPathsInDir(this.app.vault.getRoot().path, found);
        this.mindmapPaths = found;
    }

    private async listMindmapPathsInDir(dir: string, found: Set<string>): Promise<void> {
        let listed: { files: string[]; folders: string[] };
        try {
            listed = await this.app.vault.adapter.list(dir);
        } catch {
            return;
        }
        for (const filePath of listed.files) {
            if (filePath.endsWith(".mindmap")) {
                found.add(filePath);
            }
        }
        for (const folderPath of listed.folders) {
            await this.listMindmapPathsInDir(folderPath, found);
        }
    }

    async loadSettings() {
        const data = (await this.loadData()) as Partial<MindMapSettings> | null;
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
        if (data?.hotkeys) {
            this.settings.hotkeys = Object.assign({}, DEFAULT_SETTINGS.hotkeys, data.hotkeys);
        }
        if (this.settings.layoutMode !== "radial" && this.settings.layoutMode !== "outline") {
            this.settings.layoutMode = "outline";
        }
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async handleFileRename(file: TFile, oldPath: string) {
        const oldFileObj = this.getOldFileData(oldPath);
        const newName = file.basename;
        const oldName = oldFileObj.basename;

        if (oldName === newName) return;

        for (const path of this.mindmapPaths) {
            const mmFile = this.app.vault.getAbstractFileByPath(path);
            if (!(mmFile instanceof TFile)) continue;
            let content = await this.app.vault.read(mmFile);
            // Handle both exact matches and matches with aliases [[OldName|Alias]]
            const oldLinkRegex = new RegExp(`\\[\\[${this.escapeRegExp(oldName)}(\\|[^\\]]+)?\\]\\]`, 'g');

            if (content.match(oldLinkRegex)) {
                const updatedContent = content.replace(oldLinkRegex, (match, alias) => {
                    return alias ? `[[${newName}${alias}]]` : `[[${newName}]]`;
                });

                await this.app.vault.modify(mmFile, updatedContent);

                // If the file is currently open in a view, we should notify it to reload
                const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_MIND_MAP);
                for (const leaf of leaves) {
                    const view = leaf.view;
                    if (view instanceof MindMapView && view.file && view.file.path === mmFile.path) {
                        if (view.render) view.render();
                    }
                }
            }
        }
    }

    getOldFileData(oldPath: string): { basename: string; extension: string } {
        const lastSlash = oldPath.lastIndexOf("/");
        const fileName = lastSlash === -1 ? oldPath : oldPath.substring(lastSlash + 1);
        const lastDot = fileName.lastIndexOf(".");
        if (lastDot === -1) return { basename: fileName, extension: "" };
        return {
            basename: fileName.substring(0, lastDot),
            extension: fileName.substring(lastDot + 1)
        };
    }

    escapeRegExp(string: string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    async activateView() {
        const { workspace } = this.app;

        const folder = this.settings.exportFolder || "";
        await this.ensureFolderExists(folder);

        let fileName = "Untitled.mindmap";
        let path = folder ? `${folder}/${fileName}` : fileName;
        let counter = 1;

        while (this.app.vault.getAbstractFileByPath(path)) {
            fileName = `Untitled (${counter}).mindmap`;
            path = folder ? `${folder}/${fileName}` : fileName;
            counter++;
        }

        const emptyData = {
            root: { id: "root", text: "Central idea", children: [] },
        };
        const content = `---\ntype: mindmap\n---\n\n\`\`\`json\n${JSON.stringify(emptyData, null, 2)}\n\`\`\``;

        try {
            const file = await this.app.vault.create(path, content);
            const leaf = workspace.getLeaf("tab");
            await leaf.openFile(file);
        } catch (e) {
            new Notice(`Error creating mind map: ${e.message}`);
        }
    }

    async ensureFolderExists(folderPath: string) {
        if (!folderPath) return;
        const parts = folderPath.split("/");
        let currentPath = "";
        for (const part of parts) {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            const folder = this.app.vault.getAbstractFileByPath(currentPath);
            if (!folder) {
                await this.app.vault.createFolder(currentPath);
            }
        }
    }
}

class MindMapSettingTab extends PluginSettingTab {
    plugin: MindMapPlugin;

    constructor(app: App, plugin: MindMapPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();


        this.buildExportFolderSetting(new Setting(containerEl));
        this.buildThemeSetting(new Setting(containerEl));
        this.buildLayoutModeSetting(new Setting(containerEl));

        new Setting(containerEl)
            .setName("Strip metadata from full note")
            .setDesc("Automatically remove YAML frontmatter/properties when exporting content.")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.stripMetadata)
                    .onChange((value) => {
                        this.plugin.settings.stripMetadata = value;
                        void this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Show hover preview")
            .setDesc("Show the full node text when hovering over truncated nodes.")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.showHoverPreview)
                    .onChange((value) => {
                        this.plugin.settings.showHoverPreview = value;
                        void this.plugin.saveSettings();
                    })
            );

        this.buildShowFullTextSetting(new Setting(containerEl));
        this.buildMaxNodeLengthSetting(new Setting(containerEl));
        this.buildWrapLengthSetting(new Setting(containerEl));

        new Setting(containerEl).setName("Node operations").setHeading();
        const opsSection = containerEl.createDiv();
        for (const [name, key] of MindMapSettingTab.OPS_HOTKEYS) {
            this.buildHotkeySetting(new Setting(opsSection), name, key);
        }

        this.buildNodeStyleSetting(new Setting(containerEl));

        new Setting(containerEl).setName("Image export").setHeading();
        this.buildExportThemeSetting(new Setting(containerEl));
        this.buildExportTransparentSetting(new Setting(containerEl));
        this.buildExportScaleSetting(new Setting(containerEl));

        new Setting(containerEl).setName("Navigation and movement").setHeading();
        containerEl.createEl("p", { text: "Configure how you navigate and move nodes.", cls: "setting-item-description" });
        const moveSection = containerEl.createDiv();

        new Setting(moveSection)
            .setName("Multi-node selection")
            .setDesc("Modifier key to select multiple nodes during navigation.")
            .addText(text => text.setDisabled(true).setValue("Cmd / Ctrl (fixed)"));

        for (const [name, key] of MindMapSettingTab.MOVE_HOTKEYS) {
            this.buildHotkeySetting(new Setting(moveSection), name, key);
        }

        new Setting(containerEl).setName("Support").setHeading();
        const supportDiv = containerEl.createDiv();
        supportDiv.createEl("p", { text: "If you find this plugin helpful, please consider supporting the development!" });

        const coffeeBtn = supportDiv.createEl("a", { href: "https://www.buymeacoffee.com/creative781", cls: "obsimap-support-coffee" });
        coffeeBtn.createEl("img", {
            attr: {
                src: "https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png",
                alt: "Buy Me A Coffee"
            }
        });

        const socialDiv = supportDiv.createDiv({ cls: "obsimap-social-links" });

        socialDiv.createEl("a", {
            href: "https://www.youtube.com/@creative781",
            text: "📺 YouTube channel",
            cls: "obsimap-social-link"
        });

        socialDiv.createEl("a", {
            href: "https://creative781.cafe24.com/",
            text: "🏠 official blog",
            cls: "obsimap-social-link"
        });
    }

    private buildExportFolderSetting(setting: Setting): void {
        let textComp: TextComponent;
        setting
            .setName("Export folder")
            .setDesc("Default folder for exported files and new notes.")
            .addText((text) => {
                textComp = text;
                text
                    .setPlaceholder("Example: mind-maps/exports")
                    .setValue(this.plugin.settings.exportFolder)
                    .onChange((value) => {
                        this.plugin.settings.exportFolder = value;
                        void this.plugin.saveSettings();
                    });
            })
            .addButton((btn) =>
                btn.setButtonText("Select folder").onClick(() => {
                    new FolderSuggestModal(this.app, (folder) => {
                        this.plugin.settings.exportFolder = folder.path;
                        void this.plugin.saveSettings();
                        textComp.setValue(folder.path);
                    }).open();
                })
            );
    }

    private buildThemeSetting(setting: Setting): void {
        setting
            .setName("Theme")
            .setDesc("Select a color theme for your mindmap nodes.")
            .addDropdown((dropdown) =>
                dropdown
                    .addOption("default", "Default Obsidian")
                    .addOption("vibrant", "Vibrant colors")
                    .addOption("contrast", "High contrast")
                    .setValue(this.plugin.settings.theme)
                    .onChange((value) => {
                        this.plugin.settings.theme = value;
                        void this.plugin.saveSettings();
                        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_MIND_MAP);
                        const view = leaves.length > 0 ? leaves[0].view : null;
                        if (view instanceof MindMapView) view.updateTheme(this.plugin.settings.theme);
                    })
            );
    }

    private buildLayoutModeSetting(setting: Setting): void {
        setting
            .setName("Mind map layout")
            .setDesc(
                "Outline grows to the right like a list. Radial places root topics on both left and right (auto-balanced)."
            )
            .addDropdown((dropdown) =>
                dropdown
                    .addOption("outline", "Outline (list)")
                    .addOption("radial", "Radial (balanced)")
                    .setValue(this.plugin.settings.layoutMode ?? "outline")
                    .onChange((value: string) => {
                        this.plugin.settings.layoutMode = value === "radial" ? "radial" : "outline";
                        void this.plugin.saveSettings();
                        this.app.workspace.getLeavesOfType(VIEW_TYPE_MIND_MAP).forEach((leaf) => {
                            if (leaf.view instanceof MindMapView) leaf.view.render();
                        });
                    })
            );
    }

    private rerenderViews(): void {
        this.app.workspace.getLeavesOfType(VIEW_TYPE_MIND_MAP).forEach((leaf) => {
            if (leaf.view instanceof MindMapView) leaf.view.render();
        });
    }

    private buildExportThemeSetting(setting: Setting): void {
        setting
            .setName("Export colors")
            .setDesc("Colors used for SVG, PNG and PDF export.")
            .addDropdown((d) =>
                d
                    .addOption("current", "Current theme")
                    .addOption("light", "Light")
                    .addOption("dark", "Dark")
                    .setValue(this.plugin.settings.exportTheme)
                    .onChange((value) => {
                        this.plugin.settings.exportTheme = value === "light" || value === "dark" ? value : "current";
                        void this.plugin.saveSettings();
                    })
            );
    }

    private buildExportTransparentSetting(setting: Setting): void {
        setting
            .setName("Transparent background")
            .setDesc("SVG and PNG exports without background (PDF always keeps one).")
            .addToggle((t) =>
                t.setValue(this.plugin.settings.exportTransparent).onChange((value) => {
                    this.plugin.settings.exportTransparent = value;
                    void this.plugin.saveSettings();
                })
            );
    }

    private buildExportScaleSetting(setting: Setting): void {
        setting
            .setName("PNG resolution")
            .setDesc("Pixel density of PNG exports (2× is sharp on most screens, 4× for print).")
            .addDropdown((d) =>
                d
                    .addOption("1", "1×")
                    .addOption("2", "2×")
                    .addOption("3", "3×")
                    .addOption("4", "4×")
                    .setValue(String(this.plugin.settings.exportScale))
                    .onChange((value) => {
                        this.plugin.settings.exportScale = Number(value) || 2;
                        void this.plugin.saveSettings();
                    })
            );
    }

    private buildShowFullTextSetting(setting: Setting): void {
        setting
            .setName("Always show full text")
            .setDesc("Never truncate node text: long text wraps onto as many lines as needed.")
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.showFullText).onChange((value) => {
                    this.plugin.settings.showFullText = value;
                    void this.plugin.saveSettings();
                    this.rerenderViews();
                })
            );
    }

    private buildWrapLengthSetting(setting: Setting): void {
        setting
            .setName("Wrap text after")
            .setDesc("Start a new line after this many characters (at a word boundary). 0 keeps every node on one line.")
            .addSlider((slider) =>
                slider
                    .setLimits(0, 100, 1)
                    .setDynamicTooltip()
                    .setValue(this.plugin.settings.wrapLength)
                    .onChange((value) => {
                        this.plugin.settings.wrapLength = value;
                        void this.plugin.saveSettings();
                        this.rerenderViews();
                    })
            );
    }

    private buildMaxNodeLengthSetting(setting: Setting): void {
        setting
            .setName("Max node text length")
            .setDesc("The maximum number of characters to show in a node before truncating with '...'. Ignored when 'Always show full text' is on.")
            .addSlider((slider) =>
                slider
                    .setLimits(5, 100, 1)
                    .setDynamicTooltip()
                    .setValue(this.plugin.settings.maxNodeLength)
                    .onChange((value) => {
                        this.plugin.settings.maxNodeLength = value;
                        void this.plugin.saveSettings();
                        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_MIND_MAP);
                        const view = leaves.length > 0 ? leaves[0].view : null;
                        if (view instanceof MindMapView) view.render();
                    })
            );
    }

    private buildNodeStyleSetting(setting: Setting): void {
        setting
            .setName("Node style")
            .setDesc("Choose the visual appearance of nodes.")
            .addDropdown(dropdown => dropdown
                .addOption("pill", "Pill (rounded)")
                .addOption("rect", "Rectangle (sharp)")
                .setValue(this.plugin.settings.nodeStyle)
                .onChange((value: "pill" | "rect") => {
                    this.plugin.settings.nodeStyle = value;
                    void this.plugin.saveSettings();
                    this.app.workspace.getLeavesOfType(VIEW_TYPE_MIND_MAP).forEach(leaf => {
                        if (leaf.view instanceof MindMapView) leaf.view.render();
                    });
                }));
    }

    private buildHotkeySetting(setting: Setting, name: string, key: keyof MindMapSettings["hotkeys"]): void {
        setting.setName(name).addText((text) => {
            text.setValue(this.plugin.settings.hotkeys[key]);
            text.inputEl.placeholder = "Press keys...";
            text.inputEl.addEventListener("keydown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (e.key === "Escape" || e.key === "Backspace") {
                    this.plugin.settings.hotkeys[key] = "";
                    text.setValue("");
                    void this.plugin.saveSettings();
                    return;
                }
                if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
                const modifiers = [];
                if (e.ctrlKey || e.metaKey) modifiers.push("Ctrl");
                if (e.shiftKey) modifiers.push("Shift");
                if (e.altKey) modifiers.push("Alt");
                const mainKey = e.key === " " ? "Space" : e.key;
                const fullKey =
                    (modifiers.length > 0 ? modifiers.join("+") + "+" : "") +
                    (mainKey.length === 1 ? mainKey.toUpperCase() : mainKey);
                this.plugin.settings.hotkeys[key] = fullKey;
                text.setValue(fullKey);
                void this.plugin.saveSettings();
            });
        });
    }

    private static readonly OPS_HOTKEYS: Array<[string, keyof MindMapSettings["hotkeys"]]> = [
        ["Add child node", "addChild"],
        ["Add sibling node", "addSibling"],
        ["Delete node", "delete"],
        ["Rename node", "rename"],
        ["Search & link note", "searchNote"],
        ["Create note from node", "createNote"],
        ["Open linked note", "openNote"],
        ["Change node color", "changeColor"],
    ];

    private static readonly MOVE_HOTKEYS: Array<[string, keyof MindMapSettings["hotkeys"]]> = [
        ["Move node up (Shift+)", "reorderUp"],
        ["Move node down (Shift+)", "reorderDown"],
        ["Demote node (Shift+move right)", "demote"],
        ["Fold/unfold subtree", "toggleCollapse"],
    ];

    /**
     * Obsidian 1.13+ settings search index. Keep `display()` for older versions (Path B).
     * Do not call `PluginSettingTab.update()` — it requires minAppVersion 1.13+.
     */
    getSettingDefinitions() {
        const searchAliases = ["Simple Mindmap", "ObsiMap", "obsimap", "mindmap", "mind map"];
        return [
            {
                name: "Export folder",
                desc: "Default folder for exported files and new notes.",
                aliases: searchAliases,
                render: (setting: Setting) => this.buildExportFolderSetting(setting),
            },
            {
                name: "Theme",
                desc: "Select a color theme for your mindmap nodes.",
                aliases: searchAliases,
                render: (setting: Setting) => this.buildThemeSetting(setting),
            },
            {
                name: "Mind map layout",
                desc: "Outline grows to the right like a list. Radial places root topics on both left and right (auto-balanced).",
                aliases: searchAliases,
                render: (setting: Setting) => this.buildLayoutModeSetting(setting),
            },
            {
                name: "Strip metadata from full note",
                desc: "Automatically remove YAML frontmatter/properties when exporting content.",
                aliases: searchAliases,
                control: { type: "toggle", key: "stripMetadata" },
            },
            {
                name: "Show hover preview",
                desc: "Show the full node text when hovering over truncated nodes.",
                aliases: searchAliases,
                control: { type: "toggle", key: "showHoverPreview" },
            },
            {
                name: "Always show full text",
                desc: "Never truncate node text: long text wraps onto as many lines as needed.",
                aliases: searchAliases,
                render: (setting: Setting) => this.buildShowFullTextSetting(setting),
            },
            {
                name: "Max node text length",
                desc: "The maximum number of characters to show in a node before truncating with '...'. Ignored when 'Always show full text' is on.",
                aliases: searchAliases,
                render: (setting: Setting) => this.buildMaxNodeLengthSetting(setting),
            },
            {
                name: "Wrap text after",
                desc: "Start a new line after this many characters (at a word boundary). 0 keeps every node on one line.",
                aliases: searchAliases,
                render: (setting: Setting) => this.buildWrapLengthSetting(setting),
            },
            {
                name: "Export colors",
                desc: "Colors used for SVG, PNG and PDF export.",
                aliases: searchAliases,
                render: (setting: Setting) => this.buildExportThemeSetting(setting),
            },
            {
                name: "Transparent background",
                desc: "SVG and PNG exports without background (PDF always keeps one).",
                aliases: searchAliases,
                render: (setting: Setting) => this.buildExportTransparentSetting(setting),
            },
            {
                name: "PNG resolution",
                desc: "Pixel density of PNG exports (2× is sharp on most screens, 4× for print).",
                aliases: searchAliases,
                render: (setting: Setting) => this.buildExportScaleSetting(setting),
            },
            {
                name: "Node style",
                desc: "Choose the visual appearance of nodes.",
                aliases: searchAliases,
                render: (setting: Setting) => this.buildNodeStyleSetting(setting),
            },
            ...MindMapSettingTab.OPS_HOTKEYS.map(([name, key]) => ({
                name,
                aliases: searchAliases,
                render: (setting: Setting) => this.buildHotkeySetting(setting, name, key),
            })),
            ...MindMapSettingTab.MOVE_HOTKEYS.map(([name, key]) => ({
                name,
                aliases: searchAliases,
                render: (setting: Setting) => this.buildHotkeySetting(setting, name, key),
            })),
        ];
    }
}

class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
    onSelect: (folder: TFolder) => void;
    folders: TFolder[];

    constructor(app: App, onSelect: (folder: TFolder) => void) {
        super(app);
        this.onSelect = onSelect;
        this.folders = collectVaultFolders(this.app.vault.getRoot());
    }

    getItems(): TFolder[] {
        return this.folders;
    }

    getItemText(item: TFolder): string {
        return item.path;
    }

    onChooseItem(item: TFolder, evt: MouseEvent | KeyboardEvent): void {
        this.onSelect(item);
    }
}

class SaveModal extends Modal {
    fileName: string;
    onSave: (name: string) => void;

    constructor(app: App, defaultName: string, onSave: (name: string) => void) {
        super(app);
        this.fileName = defaultName;
        this.onSave = onSave;
    }

    onOpen() {
        const { contentEl } = this;
        new Setting(contentEl).setName("Save mind map").setHeading();
        new Setting(contentEl).setName("File name").addText((text) =>
            text.setValue(this.fileName).onChange((value) => (this.fileName = value))
        );
        new Setting(contentEl).addButton((btn) =>
            btn
                .setButtonText("Save")
                .setCta()
                .onClick(() => {
                    void this.onSave(this.fileName);
                    this.close();
                })
        );
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class MindMapView extends TextFileView {
    svg: SVGSVGElement;
    g: SVGGElement;
    mindMapData: { root: MindMapNode };
    selectedNodeId: string | null = null;
    selectedNodeIds: Set<string> = new Set();
    zoom = 1;
    panX = 0;
    panY = 0;
    isDragging = false;
    lastMouseX = 0;
    lastMouseY = 0;
    isEditing = false;
    /** Rename chosen from context menu; started after menu closes so focus is not stolen. */
    private pendingContextMenuRename: MindMapNode | null = null;
    settings: MindMapSettings;
    metadataCache: MetadataCache;
    plugin: MindMapPlugin;
    historyStack: string[] = [];

    // Internal Drag and Drop state
    private draggedNodeId: string | null = null;
    private dragTargetNodeId: string | null = null;
    private dragDropMode: DropMode | null = null;
    /** Pole (side) of the drop target the dragged chip will attach to. */
    private dragPole: Dir | null = null;
    private dropLinkPath: SVGPathElement | null = null;
    /** Side of each laid-out node relative to its parent (filled by layoutMindMap). */
    private dirOf = new Map<string, Dir>();
    /** Action chosen in the context menu, run once the menu has closed. */
    private pendingMenuAction: (() => void) | null = null;
    private ghostNode: SVGGElement | null = null;
    private dragStartX = 0;
    private dragStartY = 0;
    private isInternalDragging = false;
    private isToolbarExpanded = false;
    private currentTooltip: HTMLElement | null = null;
    private suppressNextClick = false;
    private suppressHotkeysUntil = 0;
    private editInputEl: HTMLInputElement | null = null;
    private editViewportResizeHandler: (() => void) | null = null;
    private viewportResizeObserver: ResizeObserver | null = null;
    private viewportResizeRaf: number | null = null;
    private svgContainerEl: HTMLElement | null = null;
    /** SVG clip rect matching the visible map pane (clips pan/zoom content). */
    private viewportClipRect: SVGRectElement | null = null;
    private viewportClipId = "";
    private boundWindowKeyDown: ((e: KeyboardEvent) => void) | null = null;
    private headerGuardKeyDown: ((e: KeyboardEvent) => void) | null = null;
    private static readonly LONG_PRESS_MS = 500;
    private static readonly LONG_PRESS_MOVE_THRESHOLD = 10;
    private static readonly SIBLING_DROP_GAP = 40;
    private static readonly BRANCH_GAP = 80;
    private static readonly SIBLING_GAP = 30;
    private static readonly RADIAL_ROOT_X = 500;
    private static readonly RADIAL_ROOT_Y = 300;
    /** Distance between a target chip and the snapped ghost while dragging onto a pole. */
    private static readonly SNAP_GAP = 46;
    /** Margin around the map in exported images. */
    private static readonly EXPORT_PADDING = 40;
    /** When dropping onto root as child in radial mode, prefer this side. */
    private pendingRootDropSide: "left" | "right" | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: MindMapPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.settings = plugin.settings;
        this.metadataCache = plugin.app.metadataCache;
        this.mindMapData = {
            root: {
                id: "root",
                text: "Central idea",
                children: [],
            },
        };
        this.selectedNodeId = "root";
        this.selectedNodeIds.add("root");
    }

    private isHeaderTitleEditing(): boolean {
        // The plugin no longer turns the view header title contenteditable;
        // rename always goes through a modal. Returning false keeps focus
        // routing simple and prevents stuck-focus on the title.
        return false;
    }

    focusContainer() {
        const container = this.containerEl.querySelector(".mindmap-svg-container");
        if (container instanceof HTMLElement) {
            container.focus({ preventScroll: true });
        }
    }

    private isNodeTextEditActive(): boolean {
        return this.editInputEl !== null && document.activeElement === this.editInputEl;
    }

    private endNodeTextEdit() {
        if (this.editInputEl) {
            this.editInputEl.blur();
        }
        this.teardownEditInput();
    }

    getViewType(): string {
        return VIEW_TYPE_MIND_MAP;
    }

    getIcon(): string {
        return "lucide-git-graph";
    }

    getDisplayText(): string {
        if (this.file) return this.file.basename;
        return "Obsimap";
    }

    getViewData(): string {
        const jsonData = JSON.stringify(this.mindMapData, null, 2);
        return `---\ntype: mindmap\n---\n\n\`\`\`json\n${jsonData}\n\`\`\``;
    }

    setViewData(data: string, clear: boolean): void {
        const jsonMatch = data.match(/```json\n([\s\S]*?)\n```/);
        if (jsonMatch) {
            const parsed = parseMindMapJson(jsonMatch[1]);
            if (parsed) {
                this.mindMapData = parsed;
                if (this.mindMapData.root) {
                    this.selectedNodeId = this.mindMapData.root.id;
                    this.selectedNodeIds.clear();
                    this.selectedNodeIds.add(this.mindMapData.root.id);
                }
            } else {
                console.error("Failed to parse mindmap data");
            }
        }
        this.render();
        window.setTimeout(() => this.focusContainer(), 200);
    }

    clear(): void {
        this.mindMapData = {
            root: { id: "root", text: "Central idea", children: [] },
        };
        this.selectedNodeId = "root";
        this.selectedNodeIds.clear();
        this.selectedNodeIds.add("root");
        this.render();
    }

    async onOpen() {
        await super.onOpen();
        const container = this.contentEl;
        container.empty();
        container.classList.add("mind-map-view");
        container.classList.add(`theme-${this.settings.theme}`);

        const svgContainer = container.createEl("div", { cls: "mindmap-svg-container" });
        this.svgContainerEl = svgContainer;
        svgContainer.tabIndex = 0;

        // Floating controls
        const controls = svgContainer.createEl("div", { cls: "mindmap-controls-floating" });
        if (!this.isToolbarExpanded) controls.classList.add("is-collapsed");

        const toggleBtn = this.createControlButton(controls, "lucide-menu", "Menu", () => {
            this.isToolbarExpanded = !this.isToolbarExpanded;
            controls.classList.toggle("is-collapsed", !this.isToolbarExpanded);
            const iconEl = toggleBtn.querySelector(".lucide");
            if (iconEl instanceof Element) iconEl.replaceWith(createDiv()); // placeholder to trigger re-icon
            setIcon(toggleBtn, this.isToolbarExpanded ? "lucide-chevron-left" : "lucide-menu");
        });
        toggleBtn.classList.add("toolbar-toggle-btn");
        setIcon(toggleBtn, this.isToolbarExpanded ? "lucide-chevron-left" : "lucide-menu");

        const btnContainer = controls.createEl("div", { cls: "toolbar-buttons" });
        this.createControlButton(btnContainer, "lucide-file-input", "Import markdown", () => void this.promptImport());
        this.createControlButton(btnContainer, "lucide-file-output", "Export markdown", () => void this.exportMarkdown());

        this.createControlButton(btnContainer, "lucide-file-text", "Full note", () => void this.exportFullNote());
        const imageBtn = this.createControlButton(btnContainer, "lucide-image-down", "Export image", () => {
            const r = imageBtn.getBoundingClientRect();
            this.openExportMenu(r.left, r.bottom + 6);
        });

        this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        this.svg.setAttribute("width", "100%");
        this.svg.setAttribute("height", "100%");
        this.svg.setAttribute("overflow", "hidden");
        this.svg.classList.add("mindmap-svg");
        svgContainer.appendChild(this.svg);

        // Clip map content to the SVG viewport (CSS overflow alone fails while panning
        // transformed SVG groups across Obsidian sidebars).
        this.viewportClipId = `obsimap-clip-${this.leaf.id}-${Date.now()}`;
        const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
        const clipPath = document.createElementNS("http://www.w3.org/2000/svg", "clipPath");
        clipPath.setAttribute("id", this.viewportClipId);
        this.viewportClipRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        this.viewportClipRect.setAttribute("x", "0");
        this.viewportClipRect.setAttribute("y", "0");
        this.viewportClipRect.setAttribute("width", "1");
        this.viewportClipRect.setAttribute("height", "1");
        clipPath.appendChild(this.viewportClipRect);
        defs.appendChild(clipPath);
        this.svg.appendChild(defs);

        const clippedRoot = document.createElementNS("http://www.w3.org/2000/svg", "g");
        clippedRoot.setAttribute("clip-path", `url(#${this.viewportClipId})`);
        this.svg.appendChild(clippedRoot);

        this.g = document.createElementNS("http://www.w3.org/2000/svg", "g");
        clippedRoot.appendChild(this.g);
        this.syncViewportClip();

        // Auto-focus the container so keyboard navigation works immediately.
        // No inline title rename — Obsidian/our modal handles renaming so focus
        // never leaves the map pane unexpectedly.
        window.setTimeout(() => {
            svgContainer.focus();
        }, 100);

        // Ensure clicking in the map pane focuses it.
        this.registerDomEvent(svgContainer, "pointerdown", (e: PointerEvent) => {
            if (e.button !== 0 && e.button !== 1) return;
            svgContainer.focus({ preventScroll: true });
        });

        // Global (bubble) hotkeys: act only when this view is active.
        this.boundWindowKeyDown = (e: KeyboardEvent) => {
            if (this.app.workspace.getActiveViewOfType(MindMapView) !== this) return;
            if (Date.now() < this.suppressHotkeysUntil) return;
            if (this.isNodeTextEditActive()) return;
            if (this.isHeaderTitleEditing()) return;

            const targetEl = e.target instanceof HTMLElement ? e.target : null;
            // Never hijack keystrokes from the Obsidian view header (title, buttons, etc.)
            if (targetEl && targetEl.closest(".view-header")) return;
            // Don't hijack normal typing.
            if (targetEl && (targetEl.tagName === "INPUT" || targetEl.tagName === "TEXTAREA" || targetEl.isContentEditable)) return;
            if (targetEl && targetEl.closest(".mindmap-control-btn")) return;
            if (targetEl && targetEl.closest(".menu")) return;

            if (e.key === " ") {
                this.setMapCursor("grab");
            }
            if (e.key === "F2") {
                e.preventDefault();
                this.renameFile();
                return;
            }
            this.handleKeyDown(e);
        };
        window.addEventListener("keydown", this.boundWindowKeyDown, false);

        this.registerDomEvent(svgContainer, "dragover", (e: DragEvent) => {
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
            this.setDragTarget(this.findDropTargetAt(e.clientX, e.clientY));
        });

        this.registerDomEvent(svgContainer, "drop", (e: DragEvent) => {
            e.preventDefault();
            const target = this.findDropTargetAt(e.clientX, e.clientY);
            this.setDragTarget(null);
            if (!target) return;
            this.handleExternalDrop(e, target.node, target.mode, target.pole);
        });

        this.registerDomEvent(svgContainer, "keyup", (e) => {
            if (e.key === " ") {
                if (!this.isDragging) this.setMapCursor("default");
            }
        });

        this.registerDomEvent(this.svg as unknown as HTMLElement, "wheel", (e: WheelEvent) => {
            e.preventDefault();
            const zoomSpeed = 0.001;
            this.zoom -= e.deltaY * zoomSpeed;
            this.zoom = Math.max(0.1, Math.min(this.zoom, 5));
            this.updateTransform();
        });

        this.registerDomEvent(this.svg as unknown as HTMLElement, "pointerdown", (e: PointerEvent) => {
            if (e.button === 0 || e.button === 1) {
                this.focusContainer();
                this.isDragging = true;
                this.lastMouseX = e.clientX;
                this.lastMouseY = e.clientY;
                this.setMapCursor("grabbing");
                this.svg.setPointerCapture(e.pointerId);
            }
        });

        this.registerDomEvent(this.svg as unknown as HTMLElement, "pointermove", (e: PointerEvent) => {
            if (this.isDragging) {
                const dx = e.clientX - this.lastMouseX;
                const dy = e.clientY - this.lastMouseY;
                this.panX += dx;
                this.panY += dy;
                this.lastMouseX = e.clientX;
                this.lastMouseY = e.clientY;
                this.updateTransform();
            }
        });

        this.registerDomEvent(this.svg as unknown as HTMLElement, "pointerup", (e: PointerEvent) => {
            this.isDragging = false;
            if (this.svg) {
                this.setMapCursor("default");
                this.svg.releasePointerCapture(e.pointerId);
            }
        });

        this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
            if (leaf === this.leaf) {
                // Short delay to ensure the pane is fully visible
                window.setTimeout(() => this.focusContainer(), 50);
            }
        }));

        this.viewportResizeObserver = new ResizeObserver(() => {
            if (this.viewportResizeRaf !== null) window.cancelAnimationFrame(this.viewportResizeRaf);
            this.viewportResizeRaf = window.requestAnimationFrame(() => {
                this.viewportResizeRaf = null;
                this.syncViewportClip();
                if (this.selectedNodeId) this.scrollSelectionIntoView();
            });
        });
        this.viewportResizeObserver.observe(svgContainer);
        this.register(() => {
            if (this.viewportResizeRaf !== null) window.cancelAnimationFrame(this.viewportResizeRaf);
            this.viewportResizeObserver?.disconnect();
            this.viewportResizeObserver = null;
        });

        this.render();
    }

    /** Keep the SVG clip rect matched to the visible map pane size. */
    private syncViewportClip(): void {
        if (!this.viewportClipRect) return;
        const w =
            this.svg?.clientWidth ||
            this.svgContainerEl?.clientWidth ||
            0;
        const h =
            this.svg?.clientHeight ||
            this.svgContainerEl?.clientHeight ||
            0;
        this.viewportClipRect.setAttribute("width", String(Math.max(1, Math.floor(w))));
        this.viewportClipRect.setAttribute("height", String(Math.max(1, Math.floor(h))));
    }

    createControlButton(container: HTMLElement, iconId: string, tooltip: string, onClick: () => void): HTMLElement {
        const btn = container.createEl("div", { cls: "mindmap-control-btn" });
        setIcon(btn, iconId);
        setTooltip(btn, tooltip);
        this.registerDomEvent(btn, "click", () => {
            onClick();
            window.requestAnimationFrame(() => this.focusContainer());
        });
        return btn;
    }

    /** Toggles the map pane cursor via CSS classes (no static inline styles). */
    private setMapCursor(mode: "grab" | "grabbing" | "default"): void {
        const svgContainer = this.svgContainerEl;
        if (!svgContainer) return;
        svgContainer.classList.toggle("is-cursor-grab", mode === "grab");
        svgContainer.classList.toggle("is-cursor-grabbing", mode === "grabbing");
    }

    updateTransform() {
        this.syncViewportClip();
        this.g.setAttribute("transform", `translate(${this.panX}, ${this.panY}) scale(${this.zoom})`);
        this.repositionActiveEditInput();
    }

    private repositionActiveEditInput(): void {
        if (!this.editInputEl || !this.selectedNodeId) return;
        const node = this.findNodeById(this.mindMapData.root, this.selectedNodeId);
        if (node) this.positionEditInput(this.editInputEl, node);
    }

    private scrollSelectionIntoView(): void {
        if (this.selectedNodeId) this.ensureNodeInView(this.selectedNodeId);
    }

    /** Pan just enough so the node fits in the visible map pane (uses live DOM bounds). */
    private ensureNodeInView(nodeId: string): void {
        if (!this.svgContainerEl || !this.g) return;

        const padding = 24;
        const containerRect = this.svgContainerEl.getBoundingClientRect();
        const viewLeft = padding;
        const viewTop = padding;
        const viewRight = containerRect.width - padding;
        const viewBottom = containerRect.height - padding;
        const viewInnerW = viewRight - viewLeft;
        const viewInnerH = viewBottom - viewTop;

        let left: number;
        let top: number;
        let right: number;
        let bottom: number;

        const nodeEl = this.svg?.querySelector(`[data-node-id="${nodeId}"]`);
        if (nodeEl instanceof SVGGElement) {
            const nodeRect = nodeEl.getBoundingClientRect();
            left = nodeRect.left - containerRect.left;
            top = nodeRect.top - containerRect.top;
            right = nodeRect.right - containerRect.left;
            bottom = nodeRect.bottom - containerRect.top;
        } else {
            const node = this.findNodeById(this.mindMapData.root, nodeId);
            if (!node) return;
            const size = this.getNodeSize(node);
            const extraRight = node.children.length > 0 ? 26 : 0;
            left = this.panX + (node.x ?? 0) * this.zoom;
            top = this.panY + (node.y ?? 0) * this.zoom;
            right = left + (size.w + extraRight) * this.zoom;
            bottom = top + size.h * this.zoom;
        }

        let dx = 0;
        let dy = 0;
        const nodeW = right - left;
        const nodeH = bottom - top;

        if (nodeW <= viewInnerW) {
            if (left < viewLeft) dx = viewLeft - left;
            else if (right > viewRight) dx = viewRight - right;
        } else {
            dx = viewLeft - left;
        }

        if (nodeH <= viewInnerH) {
            if (top < viewTop) dy = viewTop - top;
            else if (bottom > viewBottom) dy = viewBottom - bottom;
        } else {
            dy = viewTop - top;
        }

        if (dx === 0 && dy === 0) return;

        this.panX += dx;
        this.panY += dy;
        this.g.setAttribute("transform", `translate(${this.panX}, ${this.panY}) scale(${this.zoom})`);
        this.repositionActiveEditInput();
    }

    handleKeyDown(e: KeyboardEvent) {
        if (this.isNodeTextEditActive()) {
            return;
        }
        // Recover from stale edit overlay (e.g. keyboard dismissed without blur)
        if (this.editInputEl && document.activeElement !== this.editInputEl) {
            this.teardownEditInput();
        } else if (this.isEditing && !this.editInputEl) {
            this.isEditing = false;
        }
        if (
            document.activeElement?.tagName === "INPUT" ||
            document.activeElement?.tagName === "TEXTAREA"
        ) {
            return;
        }

        if (!this.selectedNodeId) return;
        const nodeId = this.selectedNodeId;
        const hotkeys = this.settings.hotkeys;

        const modifiers = [];
        if (e.ctrlKey || e.metaKey) modifiers.push("Ctrl");
        if (e.shiftKey) modifiers.push("Shift");
        if (e.altKey) modifiers.push("Alt");

        const key = e.key;
        const fullKey = (modifiers.length > 0 ? modifiers.join("+") + "+" : "") + key;

        // Undo support
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
            e.preventDefault();
            this.undo();
            return;
        }

        const matches = (configKey: string) => {
            if (!configKey) return false;
            // Handle special keys like "Delete" or "Space"
            const normalizedKey = key === " " ? "Space" : key;

            // Check for exact match including modifiers
            if (configKey === fullKey) return true;

            // Check for single key match without modifiers
            if (configKey === normalizedKey && modifiers.length === 0) return true;

            // Check for modifier + key match where key might be capitalized in config
            const parts = configKey.split("+");
            const configModifiers = parts.slice(0, -1);
            const configMainKey = parts[parts.length - 1];

            if (configMainKey.toLowerCase() !== normalizedKey.toLowerCase()) return false; // Case-insensitive key match
            if (configModifiers.length !== modifiers.length) return false;
            return configModifiers.every((m) => modifiers.includes(m));
        };

        const isMultiSelect = e.ctrlKey || e.metaKey;
        const isShift = e.shiftKey;

        // 1. Shift + Arrows: Movement (Reorder/Promote/Demote)
        if (isShift) {
            if (key === "ArrowUp") { e.preventDefault(); this.reorderNode(-1); return; }
            if (key === "ArrowDown") { e.preventDefault(); this.reorderNode(1); return; }
            if (key === "ArrowLeft") { e.preventDefault(); this.promoteNode(); return; }
            if (key === "ArrowRight") { e.preventDefault(); this.demoteNode(); return; }
        }

        // 2. Cmd/Ctrl + Arrows or Plain Arrows: Navigation/Selection
        if (key === "ArrowUp" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowRight") {
            e.preventDefault();
            if (this.isRadialLayout()) {
                this.navigateRadial(key, isMultiSelect);
            } else if (key === "ArrowUp") {
                this.navigateSibling(-1, isMultiSelect);
            } else if (key === "ArrowDown") {
                this.navigateSibling(1, isMultiSelect);
            } else if (key === "ArrowLeft") {
                this.navigateParent(isMultiSelect);
            } else if (key === "ArrowRight") {
                this.navigateChild(isMultiSelect);
            }
            return;
        }

        if (matches(hotkeys.addChild)) {
            e.preventDefault();
            this.addChildNode(nodeId);
        } else if (matches(hotkeys.addSibling)) {
            e.preventDefault();
            this.addSiblingNode(nodeId);
        } else if (matches(hotkeys.delete) || (key === "Backspace" && hotkeys.delete === "Delete")) {
            e.preventDefault();
            this.deleteNode(nodeId);
        } else if (matches(hotkeys.rename)) {
            e.preventDefault();
            const node = this.findNodeById(this.mindMapData.root, nodeId);
            if (node) this.editNode(node);
        } else if (matches(hotkeys.reorderUp)) {
            e.preventDefault();
            this.reorderNode(-1);
        } else if (matches(hotkeys.reorderDown)) {
            e.preventDefault();
            this.reorderNode(1);
        } else if (matches(hotkeys.promote)) {
            e.preventDefault();
            this.promoteNode();
        } else if (matches(hotkeys.demote)) {
            e.preventDefault();
            this.demoteNode();
        } else if (matches(hotkeys.searchNote)) {
            e.preventDefault();
            this.openNoteSearch();
        } else if (matches(hotkeys.createNote)) {
            e.preventDefault();
            void this.createNoteFromNode();
        } else if (matches(hotkeys.openNote)) {
            e.preventDefault();
            void this.openLinkedNote();
        } else if (matches(hotkeys.toggleCollapse)) {
            e.preventDefault();
            this.toggleCollapse();
        } else if (matches(hotkeys.changeColor)) {
            e.preventDefault();
            this.openColorMenuAtSelection();
        }
    }

    toggleCollapse() {
        if (this.selectedNodeIds.size === 0) return;
        this.pushHistory();
        let changed = false;
        this.selectedNodeIds.forEach(id => {
            const node = this.findNodeById(this.mindMapData.root, id);
            if (node && node.children.length > 0) {
                node.collapsed = !node.collapsed;
                changed = true;
            }
        });
        if (changed) {
            this.render();
            void this.saveMindMap(true);
        }
    }

    private getNodeDepth(nodeId: string): number {
        if (nodeId === "root") return 0;
        let depth = 0;
        let currentId = nodeId;
        while (currentId !== "root") {
            const parent = this.findParentNode(this.mindMapData.root, currentId);
            if (!parent) return -1;
            currentId = parent.id;
            depth++;
        }
        return depth;
    }

    /** True when the node is rendered (every ancestor expanded). */
    private isNodeDisplayed(nodeId: string): boolean {
        if (nodeId === "root") return true;
        const parent = this.findParentNode(this.mindMapData.root, nodeId);
        if (!parent) return false;
        if (parent.collapsed) return false;
        return this.isNodeDisplayed(parent.id);
    }

    /** All visible nodes at a given tree depth, in on-screen top-to-bottom order. */
    private getNodesAtDepth(depth: number): MindMapNode[] {
        const nodes: MindMapNode[] = [];
        const walk = (node: MindMapNode, currentDepth: number) => {
            if (currentDepth === depth) {
                if (node.id !== "root" && this.isNodeDisplayed(node.id)) {
                    nodes.push(node);
                }
                return;
            }
            if (node.collapsed) return;
            for (const child of node.children) {
                walk(child, currentDepth + 1);
            }
        };
        walk(this.mindMapData.root, 0);
        return nodes.sort((a, b) => {
            const ay = a.y ?? 0;
            const by = b.y ?? 0;
            if (ay !== by) return ay - by;
            return (a.x ?? 0) - (b.x ?? 0);
        });
    }

    /**
     * Radial layout: arrows follow on-screen direction.
     * Left branch grows leftward, so ← goes to child and → goes to parent.
     */
    navigateRadial(key: string, isMultiSelect: boolean = false) {
        if (key === "ArrowUp") {
            this.navigateSibling(-1, isMultiSelect);
            return;
        }
        if (key === "ArrowDown") {
            this.navigateSibling(1, isMultiSelect);
            return;
        }

        if (this.selectedNodeId === "root") {
            if (key === "ArrowLeft") this.navigateRootSideChild("left", isMultiSelect);
            else if (key === "ArrowRight") this.navigateRootSideChild("right", isMultiSelect);
            return;
        }

        const onLeft = this.getBranchSide(
            this.findNodeById(this.mindMapData.root, this.selectedNodeId!) ?? this.mindMapData.root
        ) === "left";

        if (key === "ArrowLeft") {
            if (onLeft) this.navigateChild(isMultiSelect);
            else this.navigateParent(isMultiSelect);
        } else if (key === "ArrowRight") {
            if (onLeft) this.navigateParent(isMultiSelect);
            else this.navigateChild(isMultiSelect);
        }
    }

    /** From root, move onto the first visible topic on that side (top-most). */
    private navigateRootSideChild(side: "left" | "right", isMultiSelect: boolean = false) {
        this.layoutMindMap();
        const children = this.mindMapData.root.children
            .filter((c) => (side === "left" ? c.side === "left" : c.side !== "left"))
            .slice()
            .sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0));
        if (children.length === 0) return;

        this.selectedNodeId = children[0].id;
        if (!isMultiSelect) {
            this.selectedNodeIds.clear();
        }
        this.selectedNodeIds.add(this.selectedNodeId);
        this.render();
        this.ensureNodeInView(this.selectedNodeId);
    }

    navigateSibling(direction: number, isMultiSelect: boolean = false) {
        if (!this.selectedNodeId) return;

        this.layoutMindMap();

        if (this.selectedNodeId === "root") {
            const children = this.mindMapData.root.children
                .slice()
                .sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0));
            if (children.length === 0) return;
            const target = direction > 0 ? children[0] : children[children.length - 1];
            this.selectedNodeId = target.id;
            if (!isMultiSelect) {
                this.selectedNodeIds.clear();
            }
            this.selectedNodeIds.add(this.selectedNodeId);
            this.render();
            this.ensureNodeInView(this.selectedNodeId);
            return;
        }

        // Prefer true siblings (same parent); in radial mode stay on the same side for root topics.
        const parent = this.findParentNode(this.mindMapData.root, this.selectedNodeId);
        if (parent) {
            let siblings = parent.children.slice();
            if (parent.id === "root" && this.isRadialLayout()) {
                const side = this.getBranchSide(
                    this.findNodeById(this.mindMapData.root, this.selectedNodeId) ?? this.mindMapData.root
                );
                siblings = siblings.filter((c) =>
                    side === "left" ? c.side === "left" : c.side !== "left"
                );
            }
            siblings.sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0));
            const index = siblings.findIndex((n) => n.id === this.selectedNodeId);
            if (index >= 0) {
                const nextIndex = index + direction;
                if (nextIndex >= 0 && nextIndex < siblings.length) {
                    this.selectedNodeId = siblings[nextIndex].id;
                    if (!isMultiSelect) {
                        this.selectedNodeIds.clear();
                    }
                    this.selectedNodeIds.add(this.selectedNodeId);
                    this.render();
                    this.ensureNodeInView(this.selectedNodeId);
                    return;
                }
            }
        }

        // Fallback: same-depth peers (outline-style cross-branch navigation)
        const depth = this.getNodeDepth(this.selectedNodeId);
        if (depth < 0) return;

        const peers = this.getNodesAtDepth(depth);
        const index = peers.findIndex((n) => n.id === this.selectedNodeId);
        if (index < 0) return;

        const nextIndex = index + direction;
        if (nextIndex < 0 || nextIndex >= peers.length) return;

        this.selectedNodeId = peers[nextIndex].id;
        if (!isMultiSelect) {
            this.selectedNodeIds.clear();
        }
        this.selectedNodeIds.add(this.selectedNodeId);
        this.render();
        this.ensureNodeInView(this.selectedNodeId);
    }

    navigateParent(isMultiSelect: boolean = false) {
        if (!this.selectedNodeId || this.selectedNodeId === "root") return;
        const parent = this.findParentNode(this.mindMapData.root, this.selectedNodeId);
        if (parent) {
            this.selectedNodeId = parent.id;
            if (!isMultiSelect) {
                this.selectedNodeIds.clear();
            }
            this.selectedNodeIds.add(this.selectedNodeId);
            this.render();
            this.ensureNodeInView(this.selectedNodeId);
        }
    }

    navigateChild(isMultiSelect: boolean = false) {
        if (!this.selectedNodeId) return;
        const node = this.findNodeById(this.mindMapData.root, this.selectedNodeId);
        if (node && node.children.length > 0 && !node.collapsed) {
            this.layoutMindMap();
            const children = node.children
                .slice()
                .sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0));
            this.selectedNodeId = children[0].id;
            if (!isMultiSelect) {
                this.selectedNodeIds.clear();
            }
            this.selectedNodeIds.add(this.selectedNodeId);
            this.render();
            this.ensureNodeInView(this.selectedNodeId);
        }
    }

    reorderNode(direction: number) {
        if (this.selectedNodeIds.size === 0 || this.selectedNodeIds.has("root")) return;

        const firstId = this.selectedNodeIds.values().next().value;
        const parent = this.findParentNode(this.mindMapData.root, firstId);
        if (parent) {
            this.pushHistory();
            const sortedIds = Array.from(this.selectedNodeIds).sort((a, b) => {
                return (
                    parent.children.findIndex((n) => n.id === a) -
                    parent.children.findIndex((n) => n.id === b)
                );
            });

            if (direction === -1) {
                for (const id of sortedIds) {
                    const index = parent.children.findIndex((n) => n.id === id);
                    if (index > 0) {
                        const targetIndex = index - 1;
                        if (!this.selectedNodeIds.has(parent.children[targetIndex].id)) {
                            const [moved] = parent.children.splice(index, 1);
                            parent.children.splice(targetIndex, 0, moved);
                        }
                    }
                }
            } else {
                for (const id of sortedIds.reverse()) {
                    const index = parent.children.findIndex((n) => n.id === id);
                    if (index < parent.children.length - 1) {
                        const targetIndex = index + 1;
                        if (!this.selectedNodeIds.has(parent.children[targetIndex].id)) {
                            const [moved] = parent.children.splice(index, 1);
                            parent.children.splice(targetIndex, 0, moved);
                        }
                    }
                }
            }
            this.render();
            this.scrollSelectionIntoView();
            void this.saveMindMap(true);
        }
    }

    promoteNode() {
        if (this.selectedNodeIds.size === 0 || this.selectedNodeIds.has("root")) return;
        const before = new Map(this.dirOf);
        const firstId = this.selectedNodeIds.values().next().value;
        const parent = this.findParentNode(this.mindMapData.root, firstId);
        if (!parent || parent.id === "root") return;
        const grandParent = this.findParentNode(this.mindMapData.root, parent.id);
        if (grandParent) {
            this.pushHistory();
            const sortedIds = Array.from(this.selectedNodeIds).sort((a, b) => {
                return (
                    parent.children.findIndex((n) => n.id === a) -
                    parent.children.findIndex((n) => n.id === b)
                );
            });

            const parentIndexInGrandParent = grandParent.children.findIndex((n) => n.id === parent.id);
            let insertOffset = 1;
            const inheritSide =
                grandParent.id === "root" && this.isRadialLayout()
                    ? parent.side === "left"
                        ? "left"
                        : "right"
                    : null;
            for (const id of sortedIds) {
                const indexInParent = parent.children.findIndex((n) => n.id === id);
                const [moved] = parent.children.splice(indexInParent, 1);
                moved.parent = grandParent.id;
                if (inheritSide) moved.side = inheritSide;
                if (parent.dir) moved.dir = parent.dir;
                else delete moved.dir;
                grandParent.children.splice(parentIndexInGrandParent + insertOffset, 0, moved);
                insertOffset++;
                this.reorientBranches([moved], before);
            }
            this.render();
            this.scrollSelectionIntoView();
            void this.saveMindMap(true);
        }
    }

    demoteNode() {
        if (this.selectedNodeIds.size === 0 || this.selectedNodeIds.has("root")) return;
        const before = new Map(this.dirOf);
        const firstId = this.selectedNodeIds.values().next().value;
        const parent = this.findParentNode(this.mindMapData.root, firstId);
        if (parent) {
            this.pushHistory();
            const sortedIds = Array.from(this.selectedNodeIds).sort((a, b) => {
                return (
                    parent.children.findIndex((n) => n.id === a) -
                    parent.children.findIndex((n) => n.id === b)
                );
            });

            const firstIndex = parent.children.findIndex((n) => n.id === sortedIds[0]);
            if (firstIndex > 0) {
                const previousSibling = parent.children[firstIndex - 1];
                const joinDir = previousSibling.children.length > 0
                    ? previousSibling.children[previousSibling.children.length - 1].dir
                    : undefined;
                for (const id of sortedIds) {
                    const index = parent.children.findIndex((n) => n.id === id);
                    const [moved] = parent.children.splice(index, 1);
                    moved.parent = previousSibling.id;
                    delete moved.side;
                    if (joinDir) moved.dir = joinDir;
                    else delete moved.dir;
                    previousSibling.children.push(moved);
                    this.reorientBranches([moved], before);
                }
                this.render();
                this.scrollSelectionIntoView();
                void this.saveMindMap(true);
            }
        }
    }

    promptImport() {
        new FileSuggestModal(this.app, (file) => {
            void this.importMarkdown(file);
        }).open();
    }

    async importMarkdown(file?: TFile) {
        const targetFile = file || this.app.workspace.getActiveFile();
        if (!targetFile) return;
        let content = await this.app.vault.read(targetFile);

        // Strip frontmatter if present
        content = content.replace(/^---[\s\S]*?---\n?/, "");

        const lines = content.split("\n");

        // The root stays as the central node, using the filename as context.
        const rootNode: MindMapNode = {
            id: "root",
            text: targetFile.basename,
            children: [],
        };

        // Stack initialized with the root node at level -1
        const stack: { node: MindMapNode; level: number }[] = [
            { node: rootNode, level: -1 }
        ];

        let lastHeadingLevel = 0;

        lines.forEach((line, index) => {
            if (!line.trim()) return;

            let level = -1;
            let text = "";

            const headingMatch = line.match(/^(#+)\s+(.*)/);
            if (headingMatch) {
                level = headingMatch[1].length; // #=1, ##=2
                text = headingMatch[2].trim();
                lastHeadingLevel = level;
            } else {
                const listMatch = line.match(/^(\s*)(?:-|\*|\d+\.)\s+(.*)/);
                if (listMatch) {
                    // Normalize tabs to spaces (2 spaces per tab is common)
                    const indentStr = listMatch[1].replace(/\t/g, "  ");
                    // Each indentation level (even 1 space) should increase the depth
                    // relative to the current heading context.
                    level = lastHeadingLevel + indentStr.length + 1;
                    text = listMatch[2].trim();
                }
            }

            if (level !== -1) {
                const node: MindMapNode = {
                    id: `${Date.now()}-${index}-${Math.random().toString(36).substring(2, 7)}`,
                    text,
                    children: [],
                };

                // Pop stack until we find a parent that is strictly "higher" in hierarchy (smaller level)
                while (stack.length > 1 && stack[stack.length - 1].level >= level) {
                    stack.pop();
                }

                const parent = stack[stack.length - 1].node;
                node.parent = parent.id;
                parent.children.push(node);
                stack.push({ node, level });
            }
        });

        this.mindMapData.root = rootNode;
        this.selectedNodeId = rootNode.id;
        this.selectedNodeIds.clear();
        this.selectedNodeIds.add(rootNode.id);
        this.render();
        void this.saveMindMap(true);
    }

    async ensureFolderExists(folderPath: string) {
        if (!folderPath) return;
        const parts = folderPath.split("/");
        let currentPath = "";
        for (const part of parts) {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            const folder = this.app.vault.getAbstractFileByPath(currentPath);
            if (!folder) {
                await this.app.vault.createFolder(currentPath);
            }
        }
    }

    async exportFullNote() {
        const rootNode = this.mindMapData.root;
        const baseFileName = `${rootNode.text.replace(/[/\\?%*:|"<>]/g, "-").trim() || "Untitled"} (Full Note)`;
        const folder = this.settings.exportFolder;
        await this.ensureFolderExists(folder);

        let fileName = `${baseFileName}.md`;
        let path = folder ? `${folder}/${fileName}` : fileName;
        let counter = 1;
        while (await this.app.vault.adapter.exists(path)) {
            fileName = `${baseFileName} (${counter}).md`;
            path = folder ? `${folder}/${fileName}` : fileName;
            counter++;
        }

        const markdown = await this.nodeToFullMarkdown(rootNode, 1);
        try {
            await this.app.vault.create(path, markdown);
            new Notice(`Full mind map exported: ${path}`);
            const newFile = this.app.vault.getAbstractFileByPath(path);
            if (newFile instanceof TFile) {
                await this.app.workspace.getLeaf("tab").openFile(newFile);
            }
        } catch (e) {
            new Notice(`Failed to export full note: ${e.message}`);
        }
    }

    async nodeToFullMarkdown(node: MindMapNode, level: number): Promise<string> {
        const indent = "    ".repeat(level - 1);
        // Bold the node text so it stands out as a "heading" for its content
        let md = `${indent}- **${node.text}**\n`;

        const wikiLinkMatch = node.text.match(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/);
        if (wikiLinkMatch) {
            const fileName = wikiLinkMatch[1];
            const file = this.app.metadataCache.getFirstLinkpathDest(fileName, "");
            if (file instanceof TFile) {
                let content = await this.app.vault.read(file);
                if (this.settings.stripMetadata) {
                    content = content.replace(/^---\n([\s\S]*?)\n---\n/, "");
                }
                const contentLines = content
                    .split("\n")
                    .map((line) => {
                        const trimmedLine = line.trim();
                        // If it's a heading in the source note, replace # with ◈ and bold it
                        if (trimmedLine.startsWith("#")) {
                            const cleanHeader = trimmedLine.replace(/^#+\s*/, "");
                            return `${indent}    **◈ ${cleanHeader}**`;
                        }
                        return `${indent}    ${line}`;
                    })
                    .join("\n");
                md += `${contentLines}\n`;
            }
        }

        for (const child of node.children) {
            md += await this.nodeToFullMarkdown(child, level + 1);
        }
        return md;
    }


    async exportMarkdown() {
        const rootNode = this.mindMapData.root;
        const baseFileName =
            (rootNode.text.replace(/[/\\?%*:|"<>]/g, "-").trim() || "Untitled ObsiMap") + " (Outline)";
        const folder = this.settings.exportFolder;
        await this.ensureFolderExists(folder);

        let fileName = `${baseFileName}.md`;
        let path = folder ? `${folder}/${fileName}` : fileName;
        let counter = 1;
        while (await this.app.vault.adapter.exists(path)) {
            fileName = `${baseFileName} (${counter}).md`;
            path = folder ? `${folder}/${fileName}` : fileName;
            counter++;
        }

        let markdown = "";
        rootNode.children.forEach((child) => {
            markdown += this.nodeToMarkdown(child, 1);
        });
        try {
            await this.app.vault.create(path, markdown);
            new Notice(`Mind map exported as a new file: ${path}`);
            const newFile = this.app.vault.getAbstractFileByPath(path);
            if (newFile instanceof TFile) {
                await this.app.workspace.getLeaf("tab").openFile(newFile);
            }
        } catch (e) {
            new Notice(`Failed to export: ${e.message}`);
            console.error(e);
        }
    }

    nodeToMarkdown(node: MindMapNode, level: number): string {
        const indent = "    ".repeat(level - 1);
        let md = `${indent}- ${node.text}\n`;
        node.children.forEach((child) => {
            md += this.nodeToMarkdown(child, level + 1);
        });
        return md;
    }


    addChildNode(parentId: string, text?: string, dir: Dir | null = null) {
        const isInitial = text === undefined;
        const actualText = isInitial ? "" : text;
        const parent = this.findNodeById(this.mindMapData.root, parentId);
        if (parent) {
            parent.collapsed = false; // Auto-expand when adding children
            this.pushHistory();
            const newNode: MindMapNode = {
                id: Date.now().toString(),
                text: actualText,
                children: [],
                parent: parentId,
            };
            if (parentId === "root" && this.isRadialLayout()) {
                newNode.side =
                    this.pendingRootDropSide ?? this.pickBalancedSide(parent.children);
                this.pendingRootDropSide = null;
            } else if (parent.children.length > 0) {
                // Join the side of the previous child (e.g. keep adding above the parent).
                const lastDir = parent.children[parent.children.length - 1].dir;
                if (lastDir) newNode.dir = lastDir;
            }
            if (dir) this.setDir(newNode, parent, dir);
            parent.children.push(newNode);
            this.selectedNodeId = newNode.id;
            this.selectedNodeIds.clear();
            this.selectedNodeIds.add(this.selectedNodeId);

            this.render();
            this.scrollSelectionIntoView();
            if (isInitial) {
                this.editNode(newNode, "New child");
            } else {
                void this.saveMindMap(true);
            }
        }
    }

    addSiblingNode(nodeId: string, text?: string) {
        if (nodeId === "root") return;
        const isInitial = text === undefined;
        const actualText = isInitial ? "" : text;
        const parent = this.findParentNode(this.mindMapData.root, nodeId);
        if (parent) {
            this.pushHistory();
            const newNode: MindMapNode = {
                id: Date.now().toString(),
                text: actualText,
                children: [],
                parent: parent.id,
            };
            const sibling = this.findNodeById(this.mindMapData.root, nodeId);
            if (parent.id === "root" && this.isRadialLayout()) {
                newNode.side = sibling?.side === "left" ? "left" : "right";
            }
            if (sibling?.dir) newNode.dir = sibling.dir;
            const index = parent.children.findIndex((n) => n.id === nodeId);
            parent.children.splice(index + 1, 0, newNode);
            this.selectedNodeId = newNode.id;
            this.selectedNodeIds.clear();
            this.selectedNodeIds.add(this.selectedNodeId);

            this.render();
            this.scrollSelectionIntoView();
            if (isInitial) {
                this.editNode(newNode, "New sibling");
            } else {
                void this.saveMindMap(true);
            }
        }
    }

    deleteNode(nodeId: string) {
        if (nodeId === "root" || this.selectedNodeIds.has("root")) return;
        const idsToDelete = this.selectedNodeIds.has(nodeId) ? Array.from(this.selectedNodeIds) : [nodeId];

        let parent: MindMapNode | null = null;
        this.pushHistory();

        for (const id of idsToDelete) {
            const p = this.findParentNode(this.mindMapData.root, id);
            if (p) {
                parent = p;
                p.children = p.children.filter((n) => n.id !== id);
            }
        }

        if (parent) {
            this.selectedNodeId = parent.id;
            this.selectedNodeIds.clear();
            this.selectedNodeIds.add(parent.id);
        } else {
            this.selectedNodeId = "root";
            this.selectedNodeIds.clear();
            this.selectedNodeIds.add("root");
        }

        this.render();
        void this.saveMindMap(true);
    }

    findNodeById(node: MindMapNode, id: string): MindMapNode | null {
        if (node.id === id) return node;
        for (const child of node.children) {
            const found = this.findNodeById(child, id);
            if (found) return found;
        }
        return null;
    }

    findParentNode(node: MindMapNode, childId: string): MindMapNode | null {
        for (const child of node.children) {
            if (child.id === childId) return node;
            const parent = this.findParentNode(child, childId);
            if (parent) return parent;
        }
        return null;
    }

    selectNode(nodeId: string, isMultiSelect: boolean, shouldRender = true) {
        if (isMultiSelect) {
            const currentParent = this.findParentNode(this.mindMapData.root, nodeId);
            if (this.selectedNodeIds.size > 0) {
                const firstId = this.selectedNodeIds.values().next().value;
                const firstParent = this.findParentNode(this.mindMapData.root, firstId);
                if (firstParent?.id === currentParent?.id) {
                    if (this.selectedNodeIds.has(nodeId)) {
                        this.selectedNodeIds.delete(nodeId);
                    } else {
                        this.selectedNodeIds.add(nodeId);
                    }
                } else {
                    this.selectedNodeIds.clear();
                    this.selectedNodeIds.add(nodeId);
                }
            } else {
                this.selectedNodeIds.add(nodeId);
            }
        } else {
            this.selectedNodeId = nodeId;
            this.selectedNodeIds.clear();
            this.selectedNodeIds.add(nodeId);
        }
        if (shouldRender) this.render();
    }

    openNodeContextMenu(node: MindMapNode, x: number, y: number) {
        // Keep a multi-selection when right-clicking one of its nodes (colour applies to all).
        if (!(this.selectedNodeIds.has(node.id) && this.selectedNodeIds.size > 1)) {
            this.selectNode(node.id, false);
        }

        const menu = new Menu();

        if (node.id !== "root") {
            menu.addItem((item) => {
                item.setTitle("Add sibling")
                    .setIcon("plus-with-circle")
                    .onClick(() => {
                        this.addSiblingNode(node.id);
                    });
            });
        }

        menu.addItem((item) => {
            item.setTitle("Add child")
                .setIcon("plus")
                .onClick(() => {
                    this.addChildNode(node.id);
                });
        });

        if (node.id !== "root") {
            menu.addItem((item) => {
                item.setTitle("Delete")
                    .setIcon("trash")
                    .onClick(() => {
                        this.deleteNode(node.id);
                    });
            });
        }

        menu.addSeparator();

        menu.addItem((item) => {
            item.setTitle("Rename")
                .setIcon("pencil")
                .onClick(() => {
                    this.pendingContextMenuRename = node;
                });
        });

        menu.addItem((item) => {
            item.setTitle("Color…")
                .setIcon("palette")
                .onClick(() => {
                    this.pendingMenuAction = () => this.openColorMenu(x, y);
                });
        });

        if (node.id !== "root") {
            menu.addItem((item) => {
                item.setTitle("Side…")
                    .setIcon("move")
                    .onClick(() => {
                        this.pendingMenuAction = () => this.openSideMenu(x, y);
                    });
            });
        }

        menu.addItem((item) => {
            item.setTitle("Search & link note")
                .setIcon("search")
                .onClick(() => {
                    this.openNoteSearch();
                });
        });

        menu.addItem((item) => {
            item.setTitle("Create note from node")
                .setIcon("file-plus")
                .onClick(() => {
                    void this.createNoteFromNode();
                });
        });

        menu.addItem((item) => {
            item.setTitle("Open linked note")
                .setIcon("file-text")
                .onClick(() => {
                    void this.openLinkedNote();
                });
        });

        menu.showAtPosition({ x, y });
        menu.onHide(() => {
            window.requestAnimationFrame(() => {
                if (this.pendingMenuAction) {
                    const action = this.pendingMenuAction;
                    this.pendingMenuAction = null;
                    action();
                    return;
                }
                if (this.pendingContextMenuRename) {
                    const target = this.pendingContextMenuRename;
                    this.pendingContextMenuRename = null;
                    this.editNode(target);
                    return;
                }
                if (!this.isEditing) {
                    this.focusContainer();
                }
            });
        });
    }

    // ------------------------------------------------------------------ colour & side

    /** Colour menu (keyboard: arrows + Enter, Esc to close). */
    openColorMenu(x: number, y: number) {
        const ids = Array.from(this.selectedNodeIds);
        const nodes = ids.map((id) => this.findNodeById(this.mindMapData.root, id)).filter((n): n is MindMapNode => !!n);
        if (nodes.length === 0) return;
        const current = nodes.every((n) => n.color === nodes[0].color) ? nodes[0].color ?? null : undefined;

        const menu = new Menu();
        for (const color of NODE_COLORS) {
            menu.addItem((item) => {
                item.setTitle(NODE_COLOR_LABELS[color])
                    .setIcon("circle")
                    .setChecked(current === color)
                    .onClick(() => this.applyColor(color));
                const iconEl = (item as unknown as { iconEl?: HTMLElement }).iconEl;
                if (iconEl) {
                    iconEl.addClass("obsimap-color-swatch");
                    iconEl.style.setProperty("--obsimap-swatch", `rgb(var(--color-${color}-rgb))`);
                }
            });
        }
        menu.addSeparator();
        menu.addItem((item) =>
            item.setTitle("No color").setIcon("circle-off").setChecked(current === null).onClick(() => this.applyColor(null))
        );
        menu.onHide(() => window.requestAnimationFrame(() => { if (!this.isEditing) this.focusContainer(); }));
        menu.showAtPosition({ x, y });
    }

    /** Open the colour menu under the selected chip (hotkey). */
    openColorMenuAtSelection() {
        if (!this.selectedNodeId) return;
        const rectEl = this.svg?.querySelector(`[data-node-id="${this.selectedNodeId}"] .mindmap-node-rect`);
        if (!(rectEl instanceof SVGElement)) return;
        const r = rectEl.getBoundingClientRect();
        this.openColorMenu(r.left, r.bottom + 6);
    }

    applyColor(color: NodeColor | null) {
        const nodes = Array.from(this.selectedNodeIds)
            .map((id) => this.findNodeById(this.mindMapData.root, id))
            .filter((n): n is MindMapNode => !!n);
        if (nodes.length === 0) return;
        this.pushHistory();
        for (const n of nodes) {
            if (color) n.color = color;
            else delete n.color;
        }
        this.render();
        void this.saveMindMap(true);
    }

    /** Move the selected chips to a side of their parent (same as dropping them on a pole). */
    openSideMenu(x: number, y: number) {
        const nodes = Array.from(this.selectedNodeIds)
            .filter((id) => id !== "root")
            .map((id) => this.findNodeById(this.mindMapData.root, id))
            .filter((n): n is MindMapNode => !!n);
        if (nodes.length === 0) return;
        const current = new Set(nodes.map((n) => this.dirOf.get(n.id)));
        const parent = this.findParentNode(this.mindMapData.root, nodes[0].id);
        const blocked = parent ? this.blockedSideOf(parent) : null;
        const menu = new Menu();
        for (const d of DIRS) {
            menu.addItem((item) =>
                item.setTitle(d === blocked ? `${DIR_LABELS[d]} (faces the grandparent)` : DIR_LABELS[d])
                    .setIcon(DIR_ICONS[d])
                    .setChecked(current.size === 1 && current.has(d))
                    .setDisabled(d === blocked)
                    .onClick(() => this.applySide(d))
            );
        }
        menu.addSeparator();
        menu.addItem((item) =>
            item.setTitle("Automatic (follow parent)").setIcon("rotate-ccw").onClick(() => this.applySide(null))
        );
        menu.onHide(() => window.requestAnimationFrame(() => { if (!this.isEditing) this.focusContainer(); }));
        menu.showAtPosition({ x, y });
    }

    applySide(dir: Dir | null) {
        const ids = Array.from(this.selectedNodeIds).filter((id) => id !== "root");
        if (ids.length === 0) return;
        this.pushHistory();
        const before = new Map(this.dirOf);
        const changed: MindMapNode[] = [];
        for (const id of ids) {
            const node = this.findNodeById(this.mindMapData.root, id);
            const parent = this.findParentNode(this.mindMapData.root, id);
            if (!node || !parent) continue;
            if (dir) this.setDir(node, parent, dir);
            else delete node.dir;
            changed.push(node);
        }
        this.reorientBranches(changed, before);
        this.render();
        this.scrollSelectionIntoView();
        void this.saveMindMap(true);
    }

    // ------------------------------------------------------------------ image export

    openExportMenu(x: number, y: number) {
        const menu = new Menu();
        const formats: [ExportFormat, string, string][] = [
            ["svg", "Export as SVG", "file-code"],
            ["png", "Export as PNG", "image"],
            ["pdf", "Export as PDF", "file-text"],
        ];
        for (const [format, title, icon] of formats) {
            menu.addItem((item) => item.setTitle(title).setIcon(icon).onClick(() => void this.exportImage(format)));
        }
        menu.showAtPosition({ x, y });
    }

    /**
     * Standalone SVG of the whole map: no selection, no UI chrome (toggles, drop
     * poles), every computed style inlined so it renders the same outside Obsidian.
     * Optionally rendered with the light or dark theme colours.
     */
    buildExportSvg(): ExportedSvg | null {
        const container = this.svgContainerEl;
        if (!container || !this.g) return null;
        const body = document.body;
        const want = this.settings.exportTheme;
        const isDark = body.classList.contains("theme-dark");
        const swapTheme = (want === "light" && isDark) || (want === "dark" && !isDark);
        const prevIds = new Set(this.selectedNodeIds);
        const prevId = this.selectedNodeId;

        container.classList.add("is-exporting");
        this.selectedNodeIds.clear();
        try {
            if (swapTheme) {
                body.classList.toggle("theme-dark");
                body.classList.toggle("theme-light");
            }
            this.render();

            const bbox = this.g.getBBox();
            const pad = MindMapView.EXPORT_PADDING;
            const width = Math.ceil(bbox.width + 2 * pad);
            const height = Math.ceil(bbox.height + 2 * pad);
            const background = this.settings.exportTransparent ? null : getComputedStyle(container).backgroundColor;

            const live = [this.g, ...Array.from(this.g.querySelectorAll("*"))];
            const clone = this.g.cloneNode(true) as SVGGElement;
            const copies = [clone, ...Array.from(clone.querySelectorAll("*"))];
            const drop: Element[] = [];
            live.forEach((el, i) => {
                const copy = copies[i];
                const cs = getComputedStyle(el);
                if (cs.display === "none") {
                    drop.push(copy);
                    return;
                }
                const decl = EXPORT_STYLE_PROPS.map((p) => {
                    let value = cs.getPropertyValue(p);
                    // Obsidian's font stacks start with '??' placeholders for unset font settings.
                    if (p === "font-family") {
                        value = value.split(",").map((f) => f.trim()).filter((f) => !/^["']?\?+["']?$/.test(f)).join(", ");
                    }
                    return `${p}:${value}`;
                }).join(";");
                copy.setAttribute("style", decl);
                copy.removeAttribute("class");
            });
            drop.forEach((el) => el.remove());
            clone.setAttribute("transform", `translate(${pad - bbox.x}, ${pad - bbox.y})`);

            const NS = "http://www.w3.org/2000/svg";
            const root = document.createElementNS(NS, "svg");
            root.setAttribute("xmlns", NS);
            root.setAttribute("width", String(width));
            root.setAttribute("height", String(height));
            root.setAttribute("viewBox", `0 0 ${width} ${height}`);
            if (background) {
                const bg = document.createElementNS(NS, "rect");
                bg.setAttribute("width", "100%");
                bg.setAttribute("height", "100%");
                bg.setAttribute("fill", background);
                root.appendChild(bg);
            }
            root.appendChild(clone);
            const svg = new XMLSerializer().serializeToString(root);
            return { svg, width, height, background };
        } finally {
            if (swapTheme) {
                body.classList.toggle("theme-dark");
                body.classList.toggle("theme-light");
            }
            container.classList.remove("is-exporting");
            prevIds.forEach((id) => this.selectedNodeIds.add(id));
            this.selectedNodeId = prevId;
            this.render();
        }
    }

    async exportImage(format: ExportFormat) {
        const doc = this.buildExportSvg();
        if (!doc) return;
        const notice = new Notice(`Exporting ${format.toUpperCase()}…`, 0);
        try {
            let data: ArrayBuffer | string;
            if (format === "svg") {
                data = `<?xml version="1.0" encoding="UTF-8"?>\n${doc.svg}`;
            } else if (format === "png") {
                data = await (await rasterize(doc, this.settings.exportScale, "image/png")).blob.arrayBuffer();
            } else {
                // PDF pages are opaque: keep the map's background.
                const pdfDoc = doc.background ? doc : { ...doc, background: "#ffffff" };
                const bytes = (await vectorPdf(pdfDoc)) ?? (await rasterPdf(pdfDoc, Math.max(3, this.settings.exportScale)));
                data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
            }

            const folder = this.settings.exportFolder || this.file?.parent?.path || "";
            const base = (this.file?.basename ?? this.mindMapData.root.text).replace(/[/\\?%*:|"<>]/g, "-").trim() || "Mind map";
            const path = folder && folder !== "/" ? `${folder}/${base}.${format}` : `${base}.${format}`;
            await this.ensureFolderExists(folder === "/" ? "" : folder);
            const existing = this.app.vault.getAbstractFileByPath(path);
            if (existing instanceof TFile) {
                if (typeof data === "string") await this.app.vault.modify(existing, data);
                else await this.app.vault.modifyBinary(existing, data);
            } else if (typeof data === "string") {
                await this.app.vault.create(path, data);
            } else {
                await this.app.vault.createBinary(path, data);
            }
            notice.hide();
            new Notice(`Mind map exported to ${path}`);
        } catch (e) {
            notice.hide();
            const message = e instanceof Error ? e.message : String(e);
            new Notice(`Export failed: ${message}`);
            console.error("[better-mindmap] export failed", e);
        }
    }

    updateTheme(theme: string) {
        const container = this.contentEl; // Use contentEl directly
        if (container) {
            container.classList.remove("theme-default", "theme-vibrant", "theme-contrast");
            container.classList.add(`theme-${theme}`);
        }
        this.render();
    }

    private createGhostNode(node: MindMapNode) {
        this.ghostNode = document.createElementNS("http://www.w3.org/2000/svg", "g");
        this.ghostNode.classList.add("mindmap-ghost-node");
        const size = this.getNodeSize(node);
        const shown = this.getDisplay(node);

        const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("rx", "20");
        rect.setAttribute("ry", "20");
        rect.setAttribute("width", size.w.toString());
        rect.setAttribute("height", size.h.toString());
        rect.setAttribute("fill", "var(--interactive-accent)");
        rect.setAttribute("stroke", "var(--interactive-accent)");
        rect.setAttribute("stroke-width", "2");

        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("text-anchor", "middle");
        text.classList.add("mindmap-node-text");
        shown.lines.forEach((line, i) => {
            const tspan = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
            tspan.setAttribute("x", (size.w / 2).toString());
            tspan.setAttribute("y", (FIRST_BASELINE + i * LINE_HEIGHT).toString());
            tspan.textContent = line;
            text.appendChild(tspan);
        });

        this.ghostNode.appendChild(rect);
        this.ghostNode.appendChild(text);
        this.g.appendChild(this.ghostNode);

        this.dropLinkPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
        this.dropLinkPath.classList.add("mindmap-drop-link");
        this.g.appendChild(this.dropLinkPath);
    }

    private removeGhostNode() {
        this.ghostNode?.remove();
        this.ghostNode = null;
        this.dropLinkPath?.remove();
        this.dropLinkPath = null;
    }

    /**
     * Ghost position: follows the cursor, or snaps next to the active pole of the
     * drop target (with a dashed preview connector) so the drop feels magnetic.
     */
    private positionGhost(draggedNode: MindMapNode, freeX: number, freeY: number) {
        if (!this.ghostNode) return;
        const target = this.dragTargetNodeId ? this.findNodeById(this.mindMapData.root, this.dragTargetNodeId) : null;
        const dir = target && this.dragDropMode === "child" ? this.dragPole ?? this.growthDir(target) : null;
        if (!target || !dir) {
            this.ghostNode.setAttribute("transform", `translate(${freeX}, ${freeY}) scale(0.9)`);
            this.ghostNode.classList.remove("is-snapped");
            this.dropLinkPath?.setAttribute("d", "");
            return;
        }
        const t = { x: target.x ?? 0, y: target.y ?? 0, ...this.getNodeSize(target) };
        const s = this.getNodeSize(draggedNode);
        const gap = MindMapView.SNAP_GAP;
        let gx = t.x + t.w / 2 - s.w / 2;
        let gy = t.y + t.h / 2 - s.h / 2;
        if (dir === "e") gx = t.x + t.w + gap;
        if (dir === "w") gx = t.x - gap - s.w;
        if (dir === "n") gy = t.y - gap - s.h;
        if (dir === "s") gy = t.y + t.h + gap;
        this.ghostNode.setAttribute("transform", `translate(${gx}, ${gy})`);
        this.ghostNode.classList.add("is-snapped");
        this.dropLinkPath?.setAttribute("d", connectorPath(t, { x: gx, y: gy, ...s }, dir));
    }

    private clientToMap(clientX: number, clientY: number): { x: number; y: number } {
        const svgRect = this.svg.getBoundingClientRect();
        return {
            x: (clientX - svgRect.left - this.panX) / this.zoom,
            y: (clientY - svgRect.top - this.panY) / this.zoom,
        };
    }

    /** Drop zones inside a node's rect (original behaviour, rotated for north/south rows). */
    private resolveDropMode(
        node: MindMapNode,
        relativeX: number,
        relativeY: number,
        width: number,
        height: number
    ): DropMode {
        if (node.id === "root") {
            if (this.isRadialLayout()) {
                if (relativeX > width * 0.6) {
                    this.pendingRootDropSide = "right";
                    return "child";
                }
                if (relativeX < width * 0.4) {
                    this.pendingRootDropSide = "left";
                    return "child";
                }
                return "replace";
            }
            if (relativeX > width * 0.6) return "child";
            return "replace";
        }
        if (this.isRowNode(node)) {
            // Siblings sit side by side: before / after are left / right.
            if (relativeX < width * 0.25) return "above";
            if (relativeX > width * 0.75) return "below";
            return "replace";
        }
        const growsLeft = this.growthDir(node) === "w";
        if (relativeY < height * 0.3) return "above";
        if (relativeY > height * 0.7) return "below";
        if (growsLeft ? relativeX < width * 0.28 : relativeX > width * 0.72) return "child";
        return "replace";
    }

    private getDropModeForPoint(node: MindMapNode, mapX: number, mapY: number): DropMode | null {
        const { w: width, h: height } = this.getNodeSize(node);
        const relX = mapX - (node.x ?? 0);
        const relY = mapY - (node.y ?? 0);
        const gap = MindMapView.SIBLING_DROP_GAP;
        const branchGap = MindMapView.BRANCH_GAP;
        const growth = this.growthDir(node);

        if (node.id !== "root" && !this.isRowNode(node)) {
            // Gap between stacked siblings (below/above indicators sit outside the rect)
            if (relX >= 0 && relX <= width) {
                if (relY >= -gap && relY < 0) return "above";
                if (relY > height && relY <= height + gap) return "below";
            }
        }

        if (relX >= 0 && relX <= width && relY >= 0 && relY <= height) {
            return this.resolveDropMode(node, relX, relY, width, height);
        }

        if (node.id === "root" && this.isRadialLayout()) {
            if (relX >= -branchGap && relX < 0 && relY >= 0 && relY <= height) {
                this.pendingRootDropSide = "left";
                return "child";
            }
            if (relX > width && relX <= width + branchGap && relY >= 0 && relY <= height) {
                this.pendingRootDropSide = "right";
                return "child";
            }
        } else if (growth === "w") {
            if (relX >= -branchGap && relX < 0 && relY >= 0 && relY <= height) return "child";
        } else if (growth === "e") {
            if (relX > width && relX <= width + branchGap && relY >= 0 && relY <= height) return "child";
        }
        return null;
    }

    /** Pole hit radius in map units: about 26 px on screen, within sane bounds. */
    private poleRadius(): number {
        return Math.min(60, Math.max(18, 26 / this.zoom));
    }

    private findDropTargetAt(
        clientX: number,
        clientY: number,
        excludeNodeId?: string | null
    ): { node: MindMapNode; mode: DropMode; pole: Dir | null } | null {
        const { x: mapX, y: mapY } = this.clientToMap(clientX, clientY);
        const candidates: MindMapNode[] = [];
        const visit = (node: MindMapNode) => {
            if (excludeNodeId) {
                if (node.id === excludeNodeId) return;
                if (this.isDescendant(excludeNodeId, node)) return;
            }
            candidates.push(node);
            if (!node.collapsed) node.children.forEach(visit);
        };
        visit(this.mindMapData.root);

        // 1. The four poles win: the nearest one, the active pole being sticky.
        let bestPole: { node: MindMapNode; pole: Dir; dist: number } | null = null;
        for (const node of candidates) {
            const size = this.getNodeSize(node);
            const relX = mapX - (node.x ?? 0);
            const relY = mapY - (node.y ?? 0);
            const prefer = node.id === this.dragTargetNodeId ? this.dragPole : null;
            const pole = hitPole(size, relX, relY, this.poleRadius(), prefer, this.blockedSideOf(node));
            if (!pole) continue;
            const p = poleCenter(size, pole);
            const dist = Math.hypot(relX - p.x, relY - p.y) - (pole === prefer ? 1000 : 0);
            if (!bestPole || dist < bestPole.dist) bestPole = { node, pole, dist };
        }
        if (bestPole) {
            this.pendingRootDropSide = null;
            return { node: bestPole.node, mode: "child", pole: bestPole.pole };
        }

        // 2. Original zones (sibling before/after, child, replace).
        let best: { node: MindMapNode; mode: DropMode; dist: number } | null = null;
        for (const node of candidates) {
            const mode = this.getDropModeForPoint(node, mapX, mapY);
            if (!mode) continue;
            const size = this.getNodeSize(node);
            const cx = (node.x ?? 0) + size.w / 2;
            const cy = (node.y ?? 0) + size.h / 2;
            const dist = Math.hypot(mapX - cx, mapY - cy);
            if (!best || dist < best.dist) best = { node, mode, dist };
        }
        if (!best) return null;
        return { node: best.node, mode: best.mode, pole: null };
    }

    private handleExternalDrop(
        e: DragEvent,
        node: MindMapNode,
        dropMode: DropMode,
        pole: Dir | null
    ) {
        let file: TFile | null = null;

        const dragManager = (this.app as App & { dragManager?: DragMgr }).dragManager;
        if (dragManager) {
            const context = dragManager.viewDragContext || dragManager.activeDrag;
            if (context?.file instanceof TFile) {
                file = context.file;
            } else if (dragManager.draggable?.file instanceof TFile) {
                file = dragManager.draggable.file;
            }
        }

        if (!file && e.dataTransfer) {
            const textData = e.dataTransfer.getData("text/plain");
            if (textData) {
                let linkPath = textData
                    .replace(/^\[\[/, "")
                    .replace(/\]\]$/, "")
                    .replace(/^\[.*\]\((.*)\)$/, "$1")
                    .split("|")[0]
                    .split("#")[0]
                    .trim();

                const abstractFile = this.app.metadataCache.getFirstLinkpathDest(linkPath, this.file?.path || "");
                if (abstractFile instanceof TFile) {
                    file = abstractFile;
                } else {
                    const fileByPath = this.app.vault.getAbstractFileByPath(linkPath);
                    if (fileByPath instanceof TFile) {
                        file = fileByPath;
                    }
                }
            }
        }

        if (file) {
            this.insertDroppedText(node, `[[${file.basename}]]`, dropMode, pole);
        } else {
            const textData = e.dataTransfer?.getData("text/plain");
            if (textData && textData.length < 200) {
                this.insertDroppedText(node, textData, dropMode, pole);
            }
        }
    }

    private insertDroppedText(targetNode: MindMapNode, text: string, dropMode: DropMode, pole: Dir | null = null) {
        if (dropMode === "replace") {
            this.pushHistory();
            targetNode.text = text;
            this.render();
            void this.saveMindMap(true);
            return;
        }
        if (dropMode === "child") {
            this.addChildNode(targetNode.id, text, pole);
            return;
        }
        const parent = this.findParentNode(this.mindMapData.root, targetNode.id);
        if (!parent) return;
        this.pushHistory();
        const newNode: MindMapNode = {
            id: `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
            text,
            children: [],
            parent: parent.id,
        };
        if (parent.id === "root" && this.isRadialLayout()) {
            newNode.side = targetNode.side === "left" ? "left" : "right";
        }
        if (targetNode.dir) newNode.dir = targetNode.dir;
        const targetIndex = parent.children.findIndex((n) => n.id === targetNode.id);
        const insertIndex = dropMode === "above" ? targetIndex : targetIndex + 1;
        parent.children.splice(insertIndex, 0, newNode);
        this.selectedNodeId = newNode.id;
        this.selectedNodeIds.clear();
        this.selectedNodeIds.add(newNode.id);
        this.render();
        this.scrollSelectionIntoView();
        void this.saveMindMap(true);
    }

    private updateDragTarget(mapX: number, mapY: number) {
        if (!this.draggedNodeId) return;
        const svgRect = this.svg.getBoundingClientRect();
        const clientX = svgRect.left + this.panX + mapX * this.zoom;
        const clientY = svgRect.top + this.panY + mapY * this.zoom;
        this.setDragTarget(this.findDropTargetAt(clientX, clientY, this.draggedNodeId));
    }

    private setDragTarget(target: { node: MindMapNode; mode: DropMode; pole: Dir | null } | null) {
        const id = target?.node.id ?? null;
        const mode = target?.mode ?? null;
        const pole = target?.pole ?? null;
        if (id === this.dragTargetNodeId && mode === this.dragDropMode && pole === this.dragPole) return;
        this.dragTargetNodeId = id;
        this.dragDropMode = mode;
        this.dragPole = pole;
        this.updateVisualIndicators();
    }

    private updateVisualIndicators() {
        this.svg.querySelectorAll(".drag-indicator-line, .drop-pole").forEach((el: SVGElement) => {
            el.classList.remove("is-visible", "is-active");
        });
        this.svg.querySelectorAll(".mindmap-node-rect").forEach((el: SVGElement) => {
            el.classList.remove("drag-target", "replace-target");
        });

        if (!this.dragTargetNodeId || !this.dragDropMode) return;
        const nodeG = this.svg.querySelector(`[data-node-id="${this.dragTargetNodeId}"]`);
        const target = this.findNodeById(this.mindMapData.root, this.dragTargetNodeId);
        if (!nodeG || !target) return;
        const rect = nodeG.querySelector(".mindmap-node-rect");
        const show = (sel: string, cls = "is-visible") => {
            const el = nodeG.querySelector(sel);
            if (el instanceof SVGElement) el.classList.add(cls);
        };

        if (this.dragDropMode === "child") {
            // All four poles appear on the target; the one the child will join lights up.
            nodeG.querySelectorAll(".drop-pole").forEach((el: SVGElement) => el.classList.add("is-visible"));
            let dir = this.dragPole ?? this.growthDir(target);
            if (!this.dragPole && target.id === "root" && this.isRadialLayout()) {
                dir = this.pendingRootDropSide === "left" ? "w" : "e";
            }
            show(`.drop-pole.pole-${dir}`, "is-active");
            if (rect) rect.classList.add("drag-target");
        } else if (this.dragDropMode === "above") {
            show(".indicator-above");
        } else if (this.dragDropMode === "below") {
            show(".indicator-below");
        } else if (this.dragDropMode === "replace") {
            if (rect) rect.classList.add("replace-target");
        }
    }

    private isDescendant(parentId: string, node: MindMapNode): boolean {
        let current = this.findParentNode(this.mindMapData.root, node.id);
        while (current) {
            if (current.id === parentId) return true;
            current = this.findParentNode(this.mindMapData.root, current.id);
        }
        return false;
    }

    private moveNode(nodeId: string, targetId: string, mode: DropMode, pole: Dir | null = null) {
        const before = new Map(this.dirOf);
        const idsToMove = this.selectedNodeIds.has(nodeId) ? Array.from(this.selectedNodeIds) : [nodeId];
        const firstId = idsToMove[0];
        const oldParent = this.findParentNode(this.mindMapData.root, firstId);

        if (oldParent) {
            this.pushHistory();

            // Support swap for single node replace mode
            if (mode === "replace" && idsToMove.length === 1) {
                const node = this.findNodeById(this.mindMapData.root, firstId);
                const targetNode = this.findNodeById(this.mindMapData.root, targetId);
                if (node && targetNode) {
                    const tempText = node.text;
                    node.text = targetNode.text;
                    targetNode.text = tempText;
                    this.render();
                    void this.saveMindMap(true);
                }
                return;
            }

            // Normal move logic for multiple nodes
            const nodesToMove: MindMapNode[] = [];
            for (const id of idsToMove) {
                const n = this.findNodeById(this.mindMapData.root, id);
                if (n) {
                    const p = this.findParentNode(this.mindMapData.root, id);
                    if (p) {
                        p.children = p.children.filter(child => child.id !== id);
                    }
                    nodesToMove.push(n);
                }
            }

            if (mode === "child") {
                const newParent = this.findNodeById(this.mindMapData.root, targetId);
                if (newParent) {
                    newParent.collapsed = false;
                    // Without a pole, join the parent's last group (original behaviour for a plain tree).
                    const joinDir = newParent.children.length > 0 ? newParent.children[newParent.children.length - 1].dir : undefined;
                    for (const node of nodesToMove) {
                        node.parent = targetId;
                        if (targetId === "root" && this.isRadialLayout()) {
                            node.side =
                                this.pendingRootDropSide ??
                                this.pickBalancedSide(newParent.children);
                        } else if (targetId !== "root") {
                            delete node.side;
                        }
                        if (pole) this.setDir(node, newParent, pole);
                        else if (joinDir && !(targetId === "root" && this.isRadialLayout())) node.dir = joinDir;
                        else delete node.dir;
                        newParent.children.push(node);
                    }
                }
            } else {
                const targetParent = this.findParentNode(this.mindMapData.root, targetId);
                if (targetParent) {
                    const targetIndex = targetParent.children.findIndex(n => n.id === targetId);
                    const insertIndex = mode === "above" ? targetIndex : targetIndex + 1;
                    const targetNode = this.findNodeById(this.mindMapData.root, targetId);

                    for (let i = 0; i < nodesToMove.length; i++) {
                        const node = nodesToMove[i];
                        node.parent = targetParent.id;
                        if (targetParent.id === "root" && this.isRadialLayout()) {
                            node.side = targetNode?.side === "left" ? "left" : "right";
                        } else {
                            delete node.side;
                        }
                        // Join the target's group (same side of the parent).
                        if (targetNode?.dir) node.dir = targetNode.dir;
                        else delete node.dir;
                        targetParent.children.splice(insertIndex + i, 0, node);
                    }
                }
            }
            this.pendingRootDropSide = null;
            this.reorientBranches(nodesToMove, before);

            this.render();
            void this.saveMindMap(true);
        }
    }

    pushHistory() {
        const state = JSON.stringify(this.mindMapData);
        if (this.historyStack.length > 0 && this.historyStack[this.historyStack.length - 1] === state) return;
        this.historyStack.push(state);
        if (this.historyStack.length > 50) this.historyStack.shift();
    }

    undo() {
        if (this.historyStack.length === 0) return;
        const prevState = this.historyStack.pop();
        if (prevState) {
            const parsed = parseMindMapJson(prevState);
            if (!parsed) return;
            this.mindMapData = parsed;
            this.render();
            void this.saveMindMap(true);
            new Notice("Undo");
        }
    }

    async saveMindMap(isAutoSave = false) {
        if (this.file) {
            this.requestSave();
            if (!isAutoSave) new Notice("Mind map saved.");
            return;
        }

        if (!isAutoSave) {
            const rootNode = this.mindMapData.root;
            const defaultName = rootNode.text.replace(/[/\\?%*:|"<>]/g, "-").trim() || "Untitled";
            new SaveModal(this.app, defaultName, (fileName) => {
                void this.performSave(fileName, false);
            }).open();
        } else {
            const rootNode = this.mindMapData.root;
            const fileName = rootNode.text.replace(/[/\\?%*:|"<>]/g, "-").trim() || "Untitled";
            await this.performSave(fileName, true);
        }
    }

    async performSave(fileName: string, isAutoSave: boolean) {
        const folder = this.settings.exportFolder;
        await this.ensureFolderExists(folder);

        const baseName = fileName.replace(/\.mindmap$/, "");
        const fullFileName = `${baseName}.mindmap`;
        const path = folder ? `${folder}/${fullFileName}` : fullFileName;

        const content = this.getViewData();

        try {
            const existingFile = this.app.vault.getAbstractFileByPath(path);
            if (existingFile instanceof TFile) {
                await this.app.vault.modify(existingFile, content);
            } else {
                await this.app.vault.create(path, content);
            }

            if (!isAutoSave) {
                new Notice(`Mind map saved to ${path}`);
                // Open the newly created file to switch to file-backed view
                const newFile = this.app.vault.getAbstractFileByPath(path);
                if (newFile instanceof TFile) {
                    await this.app.workspace.getLeaf(false).openFile(newFile);
                }
            }
        } catch (e) {
            if (!isAutoSave) new Notice(`Error saving: ${e.message}`);
        }
    }

    render() {
        if (this.currentTooltip) {
            this.currentTooltip.remove();
            this.currentTooltip = null;
        }
        if (!this.g) return;
        if (this.editInputEl) {
            this.teardownEditInput();
        }
        this.g.innerHTML = "";
        this.layoutMindMap();
        this.renderConnections(this.mindMapData.root);
        this.renderNodes(this.mindMapData.root);
        this.updateTransform();
    }

    private isRadialLayout(): boolean {
        return this.settings.layoutMode === "radial";
    }

    /** Prefer the side with fewer root topics; ties go to the right (common mind-map default). */
    private pickBalancedSide(existingRootChildren: MindMapNode[]): "left" | "right" {
        let left = 0;
        let right = 0;
        for (const child of existingRootChildren) {
            if (child.dir === "n" || child.dir === "s") continue;
            if (child.side === "left") left++;
            else right++;
        }
        return left < right ? "left" : "right";
    }

    private ensureRootChildSides() {
        const children = this.mindMapData.root.children;
        for (const child of children) {
            if (child.side !== "left" && child.side !== "right") {
                child.side = this.pickBalancedSide(children.filter((c) => c.side === "left" || c.side === "right"));
            }
        }
    }

    /** Whether the node sits on the left of its parent (radial navigation, drop zones). */
    private getBranchSide(node: MindMapNode): "left" | "right" {
        if (node.id === "root") return "right";
        return this.dirOf.get(node.id) === "w" ? "left" : "right";
    }

    // ------------------------------------------------------------------ text & size

    private textOptions(): TextOptions {
        return {
            maxNodeLength: this.settings.maxNodeLength,
            wrapLength: this.settings.wrapLength,
            showFullText: this.settings.showFullText,
        };
    }

    getDisplay(node: MindMapNode): DisplayText {
        return displayText(node.text, this.textOptions());
    }

    getNodeSize(node: MindMapNode): Size {
        return sizeOfLines(this.getDisplay(node).lines);
    }

    /** Kept for callers that only have a text. */
    getNodeWidth(text: string): number {
        return sizeOfLines(displayText(text, this.textOptions()).lines).w;
    }

    private resolveLink(target: string): TFile | null {
        const path = target.split("#")[0].trim();
        if (!path) return this.file ?? null;
        return this.app.metadataCache.getFirstLinkpathDest(path, this.file?.path ?? "");
    }

    // ------------------------------------------------------------------ directions

    /** Side of `child` relative to `parent` (explicit, or inherited). */
    private childDirOf(parent: MindMapNode, child: MindMapNode): Dir {
        const parentDir = parent.id === "root" ? "e" : this.dirOf.get(parent.id) ?? "e";
        return inheritedDir(child, parent.id === "root", parentDir, this.isRadialLayout());
    }

    /** Where a new child of this node goes by default: the side of its last child, or its own growth. */
    private growthDir(node: MindMapNode): Dir {
        if (node.children.length > 0) return this.childDirOf(node, node.children[node.children.length - 1]);
        if (node.id === "root") return "e";
        return this.dirOf.get(node.id) ?? "e";
    }

    /** Node laid out in a horizontal row with its siblings (north / south of its parent). */
    private isRowNode(node: MindMapNode): boolean {
        const d = this.dirOf.get(node.id);
        return node.id !== "root" && (d === "n" || d === "s");
    }

    /** Side of a chip facing its own parent: its children cannot go there. */
    private blockedSideOf(node: MindMapNode): Dir | null {
        return blockedDir(this.dirOf.get(node.id) ?? "e", node.id === "root");
    }

    /**
     * After nodes changed side (moved, re-parented, side menu), turn their branches
     * with them so no grandchild ends up facing back towards its grandparent.
     * `before` holds the sides from the layout preceding the change.
     */
    private reorientBranches(nodes: MindMapNode[], before: Map<string, Dir>) {
        for (const node of nodes) {
            const parent = this.findParentNode(this.mindMapData.root, node.id);
            if (!parent) continue;
            const to = this.childDirOf(parent, node);
            reorientSubtree(node, before.get(node.id) ?? to, to, before);
        }
    }

    /** Put `node` on side `dir` of `parent`; stores nothing when that is already the inherited side. */
    private setDir(node: MindMapNode, parent: MindMapNode, dir: Dir) {
        if (dir === this.blockedSideOf(parent)) return;
        if (parent.id === "root" && this.isRadialLayout() && (dir === "e" || dir === "w")) {
            node.side = dir === "w" ? "left" : "right";
        }
        delete node.dir;
        if (this.childDirOf(parent, node) !== dir) node.dir = dir;
    }

    // ------------------------------------------------------------------ layout

    layoutMindMap() {
        const radial = this.isRadialLayout();
        if (radial) this.ensureRootChildSides();
        const result = layoutTree(this.mindMapData.root, {
            radial,
            rootX: radial ? MindMapView.RADIAL_ROOT_X : 100,
            rootY: radial ? MindMapView.RADIAL_ROOT_Y : 300,
            sizeOf: (n) => this.getNodeSize(n as MindMapNode),
        });
        this.dirOf = result.dirOf;
    }

    renderNodes(node: MindMapNode) {
        this.renderNode(node);
        if (!node.collapsed) {
            node.children.forEach((child) => this.renderNodes(child));
        }
    }

    renderConnections(node: MindMapNode) {
        if (node.collapsed) return;
        const parentBox = { x: node.x ?? 0, y: node.y ?? 0, ...this.getNodeSize(node) };
        node.children.forEach((child) => {
            const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
            const childBox = { x: child.x ?? 0, y: child.y ?? 0, ...this.getNodeSize(child) };
            path.setAttribute("d", connectorPath(parentBox, childBox, this.dirOf.get(child.id) ?? "e"));
            path.classList.add("mindmap-connection");
            this.g.appendChild(path);
            this.renderConnections(child);
        });
    }

    renderNode(node: MindMapNode) {
        const nodeG = document.createElementNS("http://www.w3.org/2000/svg", "g");
        const shown = this.getDisplay(node);
        const { w: nodeWidth, h: nodeHeight } = sizeOfLines(shown.lines);
        nodeG.setAttribute("transform", `translate(${node.x}, ${node.y})`);
        nodeG.setAttribute("data-node-id", node.id);
        nodeG.classList.add("mindmap-node");
        if (node.color) {
            nodeG.classList.add("has-color");
            nodeG.style.setProperty("--obsimap-node-rgb", `var(--color-${node.color}-rgb)`);
        }
        if (shown.links.length > 0) nodeG.classList.add("has-link");

        // Add toggle button for nodes with children (on the side the children grow)
        if (node.children.length > 0) {
            const toggleAt = anchor({ w: nodeWidth, h: nodeHeight }, this.growthDir(node));
            const growth = this.growthDir(node);
            const toggleX = toggleAt.x + (growth === "e" ? 10 : growth === "w" ? -10 : 0);
            const toggleY = toggleAt.y + (growth === "s" ? 10 : growth === "n" ? -10 : 0);
            const toggleBtn = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            toggleBtn.setAttribute("cx", toggleX.toString());
            toggleBtn.setAttribute("cy", toggleY.toString());
            toggleBtn.setAttribute("r", "8");
            toggleBtn.classList.add("mindmap-node-toggle");
            nodeG.appendChild(toggleBtn);

            const toggleSymbol = document.createElementNS("http://www.w3.org/2000/svg", "text");
            toggleSymbol.setAttribute("x", toggleX.toString());
            toggleSymbol.setAttribute("y", (toggleY + 3.5).toString());
            toggleSymbol.setAttribute("text-anchor", "middle");
            toggleSymbol.classList.add("mindmap-node-toggle-symbol");
            toggleSymbol.textContent = node.collapsed ? "+" : "-";
            nodeG.appendChild(toggleSymbol);

            // Add hit area for easier clicking
            const hitArea = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            hitArea.setAttribute("cx", toggleX.toString());
            hitArea.setAttribute("cy", toggleY.toString());
            hitArea.setAttribute("r", "15"); // Larger hit area
            hitArea.setAttribute("fill", "white");
            hitArea.setAttribute("fill-opacity", "0"); // Invisible but clickable
            hitArea.classList.add("mindmap-node-toggle-hit");
            this.registerDomEvent(hitArea as unknown as HTMLElement, "pointerdown", (e: PointerEvent) => {
                e.preventDefault();
                e.stopPropagation();
                node.collapsed = !node.collapsed;
                this.render();
                void this.saveMindMap(true);
            });
            nodeG.appendChild(hitArea);
        }

        this.registerDomEvent(nodeG as unknown as HTMLElement, "contextmenu", (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            this.openNodeContextMenu(node, e.clientX, e.clientY);
        });

        this.registerDomEvent(nodeG as unknown as HTMLElement, "click", (e: MouseEvent) => {
            e.stopPropagation();
            if (this.suppressNextClick) {
                this.suppressNextClick = false;
                return;
            }
            this.selectNode(node.id, e.ctrlKey || e.metaKey || e.shiftKey);
        });

        this.registerDomEvent(nodeG as unknown as HTMLElement, "dblclick", (e: MouseEvent) => {
            e.stopPropagation();
            const wikiLinkMatch = node.text.match(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/);
            if (wikiLinkMatch) {
                const fileName = wikiLinkMatch[1];
                const file = this.app.metadataCache.getFirstLinkpathDest(fileName, "");
                if (file instanceof TFile) {
                    void this.app.workspace.getLeaf("tab").openFile(file);
                    return;
                }
            }
            this.editNode(node);
        });

        // Page preview of the linked note (Ctrl/Cmd + hover, like links in notes).
        if (shown.links.length > 0) {
            this.registerDomEvent(nodeG as unknown as HTMLElement, "mouseover", (e: MouseEvent) => {
                if (this.isInternalDragging) return;
                this.app.workspace.trigger("hover-link", {
                    event: e,
                    source: VIEW_TYPE_MIND_MAP,
                    hoverParent: this,
                    targetEl: nodeG,
                    linktext: shown.links[0],
                    sourcePath: this.file?.path ?? "",
                });
            });
        }

        // --- Internal Node Drag and Drop Logic (Stable Global Listeners) ---
        this.registerDomEvent(nodeG as unknown as HTMLElement, "pointerdown", (e: PointerEvent) => {
            if (e.button !== 0) return; // Only left click
            e.stopPropagation();

            const container = this.containerEl.querySelector(".mindmap-svg-container");
            if (container instanceof HTMLElement) {
                container.focus({ preventScroll: true });
            }

            // Select the node immediately on click (even root)
            this.selectNode(node.id, e.ctrlKey || e.metaKey || e.shiftKey);

            const useLongPress = e.pointerType === "touch" || e.pointerType === "pen";
            let longPressTimer: number | null = null;
            let cancelLongPress: (() => void) | null = null;
            if (useLongPress) {
                longPressTimer = window.setTimeout(() => {
                    longPressTimer = null;
                    if (!this.isInternalDragging) {
                        this.suppressNextClick = true;
                        this.openNodeContextMenu(node, e.clientX, e.clientY);
                    }
                }, MindMapView.LONG_PRESS_MS);

                cancelLongPress = () => {
                    if (longPressTimer !== null) {
                        window.clearTimeout(longPressTimer);
                        longPressTimer = null;
                    }
                };

                const onLongPressPointerMove = (moveEvent: PointerEvent) => {
                    const dx = moveEvent.clientX - e.clientX;
                    const dy = moveEvent.clientY - e.clientY;
                    if (
                        Math.abs(dx) > MindMapView.LONG_PRESS_MOVE_THRESHOLD ||
                        Math.abs(dy) > MindMapView.LONG_PRESS_MOVE_THRESHOLD
                    ) {
                        cancelLongPress?.();
                    }
                };

                const onLongPressPointerUp = () => {
                    cancelLongPress?.();
                    window.removeEventListener("pointermove", onLongPressPointerMove);
                    window.removeEventListener("pointerup", onLongPressPointerUp);
                    window.removeEventListener("pointercancel", onLongPressPointerUp);
                };

                window.addEventListener("pointermove", onLongPressPointerMove);
                window.addEventListener("pointerup", onLongPressPointerUp);
                window.addEventListener("pointercancel", onLongPressPointerUp);
            }

            if (node.id === "root") return; // Root cannot be dragged

            // The node group is re-rendered on select: measure the fresh one.
            const liveG = this.svg.querySelector(`[data-node-id="${node.id}"] .mindmap-node-rect`) ?? nodeG;
            const rectBounds = liveG.getBoundingClientRect();
            // Calculate initial click offset relative to node Top-Left (SCREEN coords)
            const clickOffsetX = e.clientX - rectBounds.left;
            const clickOffsetY = e.clientY - rectBounds.top;

            this.draggedNodeId = node.id;
            this.dragStartX = e.clientX;
            this.dragStartY = e.clientY;
            this.isInternalDragging = false;

            const onPointerMove = (moveEvent: PointerEvent) => {
                const dx = moveEvent.clientX - this.dragStartX;
                const dy = moveEvent.clientY - this.dragStartY;

                if (!this.isInternalDragging && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
                    cancelLongPress?.();
                    this.isInternalDragging = true;
                    this.createGhostNode(node);
                }

                if (this.isInternalDragging && this.ghostNode) {
                    const { x: mapX, y: mapY } = this.clientToMap(moveEvent.clientX, moveEvent.clientY);
                    this.updateDragTarget(mapX, mapY);
                    // Ghost node top-left in MAP space, maintaining starting offset
                    this.positionGhost(node, mapX - clickOffsetX / this.zoom, mapY - clickOffsetY / this.zoom);
                }
            };

            const onPointerUp = (_upEvent: PointerEvent) => {
                window.removeEventListener("pointermove", onPointerMove);
                window.removeEventListener("pointerup", onPointerUp);

                if (this.isInternalDragging) {
                    if (this.dragTargetNodeId && this.draggedNodeId && this.dragTargetNodeId !== this.draggedNodeId && this.dragDropMode) {
                        this.moveNode(this.draggedNodeId, this.dragTargetNodeId, this.dragDropMode, this.dragPole);
                    }
                    this.removeGhostNode();
                    this.dragTargetNodeId = null;
                    this.dragDropMode = null;
                    this.dragPole = null;
                    this.render();
                }

                this.draggedNodeId = null;
                this.isInternalDragging = false;
            };

            window.addEventListener("pointermove", onPointerMove);
            window.addEventListener("pointerup", onPointerUp);
        });

        const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        const nodeStyle = this.settings.nodeStyle;
        const rx = nodeStyle === "pill" ? "20" : "4";
        rect.setAttribute("rx", rx);
        rect.setAttribute("ry", rx);
        rect.setAttribute("width", nodeWidth.toString());
        rect.setAttribute("height", nodeHeight.toString());
        rect.classList.add("mindmap-node-rect");

        if (this.selectedNodeIds.has(node.id)) {
            rect.classList.add("is-selected");
        }

        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("text-anchor", "middle");
        text.classList.add("mindmap-node-text");
        shown.spans.forEach((line, i) => {
            const lineEl = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
            lineEl.setAttribute("x", (nodeWidth / 2).toString());
            lineEl.setAttribute("y", (FIRST_BASELINE + i * LINE_HEIGHT).toString());
            for (const span of line) {
                const spanEl = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
                spanEl.textContent = span.text;
                if (span.link) {
                    spanEl.classList.add("mindmap-node-link");
                    if (!this.resolveLink(span.link.target)) spanEl.classList.add("is-unresolved");
                }
                lineEl.appendChild(spanEl);
            }
            text.appendChild(lineEl);
        });

        if (this.settings.showHoverPreview && shown.truncated) {
            this.registerDomEvent(nodeG as unknown as HTMLElement, "mouseenter", (e: MouseEvent) => {
                if (this.currentTooltip) this.currentTooltip.remove();

                this.currentTooltip = document.body.createEl("div", { cls: "mindmap-tooltip", text: shown.plain });
                this.currentTooltip.setCssStyles({
                    left: `${e.clientX + 15}px`,
                    top: `${e.clientY + 15}px`
                });

                const onMouseMove = (moveEvent: MouseEvent) => {
                    if (this.currentTooltip) {
                        this.currentTooltip.setCssStyles({
                            left: `${moveEvent.clientX + 15}px`,
                            top: `${moveEvent.clientY + 15}px`
                        });
                    }
                };

                const onMouseLeave = () => {
                    if (this.currentTooltip) {
                        this.currentTooltip.remove();
                        this.currentTooltip = null;
                    }
                    window.removeEventListener("mousemove", onMouseMove);
                    nodeG.removeEventListener("mouseleave", onMouseLeave);
                };

                window.addEventListener("mousemove", onMouseMove);
                nodeG.addEventListener("mouseleave", onMouseLeave);
            });
        }

        nodeG.appendChild(rect);
        nodeG.appendChild(text);

        // --- Drag Indicators (Always present but hidden) ---
        // Four poles: drop on one to attach the dragged chip on that side.
        for (const d of DIRS) {
            const p = poleCenter({ w: nodeWidth, h: nodeHeight }, d);
            const pole = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            pole.setAttribute("cx", p.x.toString());
            pole.setAttribute("cy", p.y.toString());
            pole.setAttribute("r", "6");
            pole.classList.add("drop-pole", `pole-${d}`);
            if (d === this.blockedSideOf(node)) pole.classList.add("is-blocked");
            nodeG.appendChild(pole);
        }

        // Sibling before / after: above-below for vertical stacks, left-right for rows.
        const lineLen = 80;
        const gap = MindMapView.SIBLING_DROP_GAP;
        const mkLine = (cls: string, x1: number, y1: number, x2: number, y2: number) => {
            const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
            line.setAttribute("x1", x1.toString());
            line.setAttribute("y1", y1.toString());
            line.setAttribute("x2", x2.toString());
            line.setAttribute("y2", y2.toString());
            line.classList.add("drag-indicator-line", cls);
            nodeG.appendChild(line);
        };
        if (this.isRowNode(node)) {
            const half = Math.min(lineLen, nodeHeight + 20) / 2;
            mkLine("indicator-above", -gap / 2, nodeHeight / 2 - half, -gap / 2, nodeHeight / 2 + half);
            mkLine("indicator-below", nodeWidth + gap / 2, nodeHeight / 2 - half, nodeWidth + gap / 2, nodeHeight / 2 + half);
        } else {
            mkLine("indicator-above", nodeWidth / 2 - lineLen / 2, -gap / 2, nodeWidth / 2 + lineLen / 2, -gap / 2);
            mkLine("indicator-below", nodeWidth / 2 - lineLen / 2, nodeHeight + gap / 2, nodeWidth / 2 + lineLen / 2, nodeHeight + gap / 2);
        }

        this.g.appendChild(nodeG);
    }

    /** Align edit overlay to the rendered node rect (stable across pan/zoom). */
    private positionEditInput(input: HTMLInputElement, node: MindMapNode) {
        const container = this.svgContainerEl;
        if (!container) return;

        // Measure the chip itself (the node group also holds the toggle and drop poles).
        const rectEl = this.svg?.querySelector(`[data-node-id="${node.id}"] .mindmap-node-rect`);
        if (rectEl instanceof SVGElement) {
            const nodeBounds = rectEl.getBoundingClientRect();
            const containerBounds = container.getBoundingClientRect();
            const height = nodeBounds.height > 0 ? nodeBounds.height : this.getNodeSize(node).h * this.zoom;
            input.setCssStyles({
                left: `${nodeBounds.left - containerBounds.left}px`,
                top: `${nodeBounds.top - containerBounds.top}px`,
                width: `${nodeBounds.width}px`,
                height: `${height}px`,
                fontSize: `${Math.max(16, 14 * this.zoom)}px`,
            });
            return;
        }

        const size = this.getNodeSize(node);
        input.setCssStyles({
            left: `${this.panX + (node.x ?? 0) * this.zoom}px`,
            top: `${this.panY + (node.y ?? 0) * this.zoom}px`,
            width: `${size.w * this.zoom}px`,
            height: `${size.h * this.zoom}px`,
            fontSize: `${Math.max(16, 14 * this.zoom)}px`,
        });
    }

    private teardownEditInput() {
        if (this.editViewportResizeHandler) {
            window.visualViewport?.removeEventListener("resize", this.editViewportResizeHandler);
            this.editViewportResizeHandler = null;
        }
        // Clear the state before detaching: removing a focused input fires "blur"
        // synchronously, which must not re-enter save() (it threw "removeChild" errors).
        const input = this.editInputEl;
        this.editInputEl = null;
        this.isEditing = false;
        input?.remove();
    }

    editNode(node: MindMapNode, fallbackOnEmpty?: string) {
        const container = this.containerEl.querySelector(".mindmap-svg-container");
        if (!(container instanceof HTMLElement)) return;

        this.teardownEditInput();
        this.isEditing = true;
        const input = container.createEl("input", {
            type: "text",
            cls: "mindmap-edit-input",
            value: node.text,
            attr: {
                autocomplete: "off",
                autocorrect: "off",
                autocapitalize: "off",
                spellcheck: "false",
            },
        });
        this.editInputEl = input;
        this.ensureNodeInView(node.id);
        this.positionEditInput(input, node);

        this.editViewportResizeHandler = () => {
            this.ensureNodeInView(node.id);
            if (this.editInputEl) this.positionEditInput(this.editInputEl, node);
        };
        window.visualViewport?.addEventListener("resize", this.editViewportResizeHandler);

        const editOpenedAt = Date.now();
        input.focus({ preventScroll: true });
        input.select();

        const save = async () => {
            if (!this.isEditing) return;
            this.teardownEditInput();
            this.pushHistory();
            const oldText = node.text;
            let newText = input.value;

            if (newText.trim() === "" && fallbackOnEmpty) {
                newText = fallbackOnEmpty;
            }

            // Bidirectional renaming: if it's a wikilink, rename the file too
            const oldWikiMatch = oldText.match(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/);
            const newWikiMatch = newText.match(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/);

            if (oldWikiMatch && newWikiMatch) {
                const oldFileName = oldWikiMatch[1];
                const newFileName = newWikiMatch[1];

                if (oldFileName !== newFileName) {
                    const file = this.app.metadataCache.getFirstLinkpathDest(oldFileName, "");
                    if (file instanceof TFile) {
                        this.plugin.isInternalRenaming = true;
                        try {
                            const folder = file.parent ? file.parent.path : "";
                            const newPath = folder ? `${folder}/${newFileName}.md` : `${newFileName}.md`;

                            // Check if path actually changed
                            if (newPath !== file.path) {
                                const destinationFile = this.app.vault.getAbstractFileByPath(newPath);
                                if (destinationFile) {
                                    new Notice(`Cannot rename note: "${newFileName}.md" already exists.`);
                                } else {
                                    await this.app.vault.rename(file, newPath);
                                }
                            }
                        } catch (e: unknown) {
                            const message = e instanceof Error ? e.message : String(e);
                            if (!message.includes("already exists")) {
                                new Notice(`Failed to rename linked note: ${message}`);
                            }
                        } finally {
                            // Delay resetting the flag to let events clear
                            window.setTimeout(() => { this.plugin.isInternalRenaming = false; }, 100);
                        }
                    }
                }
            }

            node.text = newText;
            this.render();
            void this.saveMindMap(true);
            window.setTimeout(() => this.focusContainer(), 50);
        };

        const cancel = () => {
            if (!this.isEditing) return;
            this.teardownEditInput();
            this.render();
            window.setTimeout(() => this.focusContainer(), 50);
        };

        input.addEventListener("blur", () => {
            // Ignore focus loss right after open (e.g. context menu dismiss on iPad).
            if (Date.now() - editOpenedAt < 300) {
                window.requestAnimationFrame(() => {
                    if (this.editInputEl === input && this.isEditing) {
                        input.focus({ preventScroll: true });
                    }
                });
                return;
            }
            if (this.isEditing) void save();
        });

        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                this.suppressHotkeysUntil = Date.now() + 150;
                void save();
            } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                this.suppressHotkeysUntil = Date.now() + 150;
                cancel();
            }
        });
    }

    async onClose() {
        if (this.boundWindowKeyDown) window.removeEventListener("keydown", this.boundWindowKeyDown, false);
        this.boundWindowKeyDown = null;
        this.headerGuardKeyDown = null;
        this.teardownEditInput();
    }

    openNoteSearch() {
        if (!this.selectedNodeId) return;
        const node = this.findNodeById(this.mindMapData.root, this.selectedNodeId);
        if (!node) return;

        new NoteSuggestModal(this.app, (file) => {
            this.pushHistory();
            node.text = `[[${file.basename}]]`;
            this.render();
            const container = this.containerEl.querySelector(".mindmap-svg-container");
            if (container instanceof HTMLElement) container.focus();
        }).open();
    }

    async createNoteFromNode() {
        if (!this.selectedNodeId) return;
        const node = this.findNodeById(this.mindMapData.root, this.selectedNodeId);
        if (!node) return;

        let fileName = node.text.replace(/\[\[(.*?)\]\]/, "$1").trim();
        if (!fileName) return;

        const folder = this.settings.exportFolder || "";
        await this.ensureFolderExists(folder);

        const path = folder ? `${folder}/${fileName}.md` : `${fileName}.md`;

        try {
            let file = this.app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) {
                file = await this.app.vault.create(path, "");
            }

            if (file instanceof TFile) {
                this.pushHistory();
                node.text = `[[${file.basename}]]`;
                this.render();
                void this.saveMindMap(true);
                await this.app.workspace.getLeaf("tab").openFile(file);
                new Notice(`New note created and linked: ${file.basename}`);
            }
        } catch (e) {
            new Notice(`Error creating note: ${e.message}`);
        }
    }

    renameFile() {
        if (!this.file) return;
        new RenameModal(this.app, this.file.basename, (newName) => {
            const file = this.file;
            if (file && newName && newName !== file.basename) {
                const folderPath = file.parent?.path;
                const newPath = (!folderPath || folderPath === "/")
                    ? `${newName}.mindmap`
                    : `${folderPath}/${newName}.mindmap`;
                void this.app.vault.rename(file, newPath);
            }
            window.setTimeout(() => this.focusContainer(), 0);
        }).open();
    }

    async openLinkedNote() {
        if (!this.selectedNodeId) return;
        const node = this.findNodeById(this.mindMapData.root, this.selectedNodeId);
        if (!node) return;

        const wikiLinkMatch = node.text.match(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/);
        if (wikiLinkMatch) {
            const fileName = wikiLinkMatch[1];
            const file = this.app.metadataCache.getFirstLinkpathDest(fileName, "");
            if (file instanceof TFile) {
                await this.app.workspace.getLeaf("tab").openFile(file);
            } else {
                new Notice(`File not found: ${fileName}`);
            }
        } else {
            new Notice("No linked note found in this node.");
        }
    }
}

class NoteSuggestModal extends FuzzySuggestModal<TFile> {
    onSelect: (file: TFile) => void;

    constructor(app: App, onSelect: (file: TFile) => void) {
        super(app);
        this.onSelect = onSelect;
    }

    getItems(): TFile[] {
        return collectMarkdownFilesInFolder(this.app.vault.getRoot());
    }

    getItemText(file: TFile): string {
        return file.path;
    }

    onChooseItem(file: TFile, evt: MouseEvent | KeyboardEvent): void {
        this.onSelect(file);
    }
}

class FileSuggestModal extends FuzzySuggestModal<TFile> {
    onSelect: (file: TFile) => void;

    constructor(app: App, onSelect: (file: TFile) => void) {
        super(app);
        this.onSelect = onSelect;
    }

    getItems(): TFile[] {
        return collectMarkdownFilesInFolder(this.app.vault.getRoot());
    }

    getItemText(file: TFile): string {
        return file.path;
    }

    onChooseItem(file: TFile, evt: MouseEvent | KeyboardEvent): void {
        this.onSelect(file);
    }
}

class RenameModal extends Modal {
    newName: string;
    onRename: (newName: string) => void;

    constructor(app: App, currentName: string, onRename: (newName: string) => void) {
        super(app);
        this.newName = currentName;
        this.onRename = onRename;
    }

    onOpen() {
        const { contentEl } = this;
        new Setting(contentEl).setName("Rename mind map").setHeading();
        new Setting(contentEl).setName("New name").addText((text) =>
            text.setValue(this.newName).onChange((value) => (this.newName = value))
        );
        new Setting(contentEl).addButton((btn) =>
            btn
                .setButtonText("Rename")
                .setCta()
                .onClick(() => {
                    void this.onRename(this.newName);
                    this.close();
                })
        );
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

