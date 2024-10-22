import { App, Plugin, Setting, TFile, TFolder, Modal, FuzzySuggestModal, FrontMatterCache, Notice } from 'obsidian';

interface Property {
    id: string;
    key: string;
    value: any;
    type: string;
    types?: Set<string>;
}

export default class ObsidianDatabaseProperties extends Plugin {

    frontmatterLists: Array<Property>[] = [];
    wikiLinkPattern = /^\[\[.*\]\]$/;

    async onload() {
        this.addRibbonIcon('egg', 'Database Properties', () => new DatabasePropertiesModal(this.app, this).open());

        this.addCommand({
            id: 'database-properties',
            name: 'Open',
            callback: () => new DatabasePropertiesModal(this.app, this).open(),
        });
    }

    async getFilesByFolder(folderPath: string): Promise<TFile[]> {
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (folder instanceof TFolder) {
            return folder.children.filter((file): file is TFile => file instanceof TFile);
        }
        return [];
    }

    async getFilesByTag(tag: string): Promise<TFile[]> {
        const fileList = this.app.vault.getMarkdownFiles();
        return fileList.filter(file => {
            const cache = this.app.metadataCache.getFileCache(file);
            if (!cache) return false;
            // 检查文件的标签列表
            if (cache.tags && cache.tags.some(t => t.tag === `#${tag}` || t.tag === tag)) {
                return true;
            }
            // 检查 frontmatter 中的标签
            if (cache.frontmatter) {
                const frontmatterTags = cache.frontmatter.tags || cache.frontmatter.tag;
                if (frontmatterTags) {
                    if (Array.isArray(frontmatterTags)) {
                        if (frontmatterTags.includes(tag) || frontmatterTags.includes(`#${tag}`)) {
                            return true;
                        }
                    } else if (typeof frontmatterTags === 'string') {
                        if (frontmatterTags === tag || frontmatterTags === `#${tag}`) {
                            return true;
                        }
                    }
                }
            }
            return false;
        });
    }

     async getProperties(fileList: TFile[]): Promise<Property[]> {
        const propertiesMap = new Map<string, Property>();
        for (const file of fileList) {
            const frontmatterList: Property[] = [];
            const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
            if (frontmatter) {
                Object.entries(frontmatter).forEach(([key, value]) => {
                    const fm: Property = { id: '', key, value, type: '' };
                    if (!propertiesMap.has(key)) {
                        const id = crypto.randomUUID();
                        fm.id = id;
                        propertiesMap.set(key, {
                            id,
                            key,
                            value: '',
                            type: '',
                            types: new Set<string>(),
                        });
                    } else {
                        fm.id = propertiesMap.get(key)?.id || '';
                    }
                    const types = propertiesMap.get(key)?.types || new Set<string>();
                    const type = this.getPropertyType(value);
                    types.add(type);
                    
                    fm.type = type;
                    frontmatterList.push(fm);
                });
            }
            this.frontmatterLists.push(frontmatterList);
        }

        return Array.from(propertiesMap.values()).map(prop => ({
            id: prop.id,
            key: prop.key,
            value: prop.value,
            type: Array.from(prop.types || []).join(' | '),
        }));
    }

    getPropertyType(value: any): string {
        if (value === null || value === undefined) {
            return 'Null';
        }
        if (Array.isArray(value)) {
            return 'List';
        }
        if (typeof value === 'boolean') {
            return 'Checkbox';
        }
        if (typeof value === 'number') {
            return 'Number';
        }
        if (value instanceof Date) {
            return 'Date & time';
        }
        if (typeof value === 'string') {
            // 日期格式 (YYYY-MM-DD)
            if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
                return 'Date';
            }
            // 日期 & 时间格式 (YYYY-MM-DD HH:mm)
            if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)) {
                return 'Date & time';
            }
        }
        return 'Text';
    }

    async updateMarkdownFiles(fileList: TFile[], propertyList: Property[]) {

        const notice = new Notice('Processing files...', 0);
        const length = fileList.length;

        for (let i = 0; i < length; i++) {

            notice.setMessage(`Processing file ${i + 1} of ${length}...`);
            const file = fileList[i];
            const content = await this.app.vault.read(file);
            const frontmatterList = this.frontmatterLists[i];

            const renderList = propertyList.map(prop => {
                const found = frontmatterList.find(fm => fm.id === prop.id) || prop;
                const key = prop.key;
                const value = found.value;
                return `${key}: ${this.stringifyValue(value)}`;
            });

            const newFrontmatter = renderList.length ? `---\n${renderList.join('\n')}\n---\n` : '';
            const newContent = content.split('---').slice(2).join('---').trim();
            const value = `${newFrontmatter}${newContent}`;
            await this.app.vault.modify(file, value);
        }

        notice.hide();
    }

    stringifyValue(value: any): string {
        if (Array.isArray(value)) {
            const string = value.map(v => {
                if (this.wikiLinkPattern.test(v)) {
                    return `\n  - "${v.replace(/"/g, '\\"')}"`;
                } else {
                    return `\n  - ${v}`;
                }
            }).join('');
            return string;
        }
        return value;
    }
}

// 主弹窗
class DatabasePropertiesModal extends Modal {

    plugin: ObsidianDatabaseProperties;
    fileList: TFile[] = [];
    // 当前属性列表
    propertyList: Property[] = [];
    selectSectionEl: HTMLElement;
    listSectionEl: HTMLElement;
    addSectionEl: HTMLElement;
    saveSectionEl: HTMLElement;
    addInputEl: HTMLElement;
    internalpropertyList: string[] = ['tags', 'aliases', 'cssclasses'];
    newAddName: string = '';

    constructor(app: App, plugin: ObsidianDatabaseProperties) {
        super(app);
        this.plugin = plugin;
    }

    async onOpen() {

        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h4', { text: 'Database Properties' });

        this.selectSectionEl = contentEl.createEl('div', { cls: 'dbp-section' });
        this.listSectionEl = contentEl.createEl('div', { cls: 'dbp-section dbp-draggable-list' });
        this.addSectionEl = contentEl.createEl('div', { cls: 'dbp-section' });
        this.saveSectionEl = contentEl.createEl('div', { cls: 'dbp-section' });

        const setting = new Setting(this.selectSectionEl)
            .setName('Select Any Database Files')
            .addButton(button => button
                .setButtonText('By Folder')
                .onClick(async () => {
                    new FolderSuggestModal(this.app, async (folder) => {
                        this.fileList = await this.plugin.getFilesByFolder(folder);
                        await this.initializeView();
                        setting.setName(`Selected Folder: ${folder}`);
                    }).open();
                }))
            .addButton(button => button
                .setButtonText('By Tag')
                .onClick(async () => {
                    new TagSuggestModal(this.app, async (tag) => {
                        this.fileList = await this.plugin.getFilesByTag(tag);
                        await this.initializeView();
                        setting.setName(`Selected Tag: ${tag}`);
                    }).open();
                }));

        this.updateSaveSection();
    }

    async initializeView() {
        // 清空所有文件的属性缓存
        this.plugin.frontmatterLists = [];
        this.propertyList = await this.plugin.getProperties(this.fileList);
        this.refreshView();
    }

    async refreshView() {
        this.updateListSection();
        if (this.fileList.length > 0) {
            this.updateAddSection();
        }
        this.updateSaveSection();
    }

    updateListSection() {
        this.listSectionEl.empty();

        for (const prop of this.propertyList) {
            const setting = new Setting(this.listSectionEl).setName(prop.key).setDesc(`Type: ${prop.type}`);

            const settingEl = setting.settingEl;
            settingEl.setAttribute('draggable', 'true');
            settingEl.setAttribute('data-id', prop.id);

            settingEl.addEventListener('dragstart', (event: DragEvent) => this.onDragStart(event, prop));
            settingEl.addEventListener('dragover', (event: DragEvent) => this.onDragOver(event));
            settingEl.addEventListener('drop', (event: DragEvent) => this.onDrop(event));

            const dragHandle = settingEl.createEl('span', { cls: 'drag-handle', text: '☰' });
            settingEl.prepend(dragHandle);

            if (!this.internalpropertyList.includes(prop.key)) {
                setting.addButton(button => button
                    .setIcon('pencil')
                    .setTooltip('Rename Property')
                    .onClick(() => {
                        new RenamePropertyModal(this.app, prop.key, (name) => {
                            if (name && !this.propertyList.some(p => p.key === name)) {
                                prop.key = name;
                                this.refreshView();
                            }
                        }).open();
                    }));
            }

            setting.addButton(button => button
                .setIcon('trash')
                .setTooltip('Delete Property')
                .onClick(() => {
                    new ConfirmationModal(this.app, 
                        'Confirm Delete', 
                        `Sure to delete the property "${prop.key}" ?`, 
                        'Confirm',
                        () => {
                            this.propertyList = this.propertyList.filter(p => p !== prop);
                            this.refreshView();
                        }
                    ).open();
                }));
        }
    }

    onDragStart(event: DragEvent, prop: Property) {
        if (event.dataTransfer) {
            event.dataTransfer.setData('text/plain', prop.id);
        }
    }

    onDragOver(event: DragEvent) {
        event.preventDefault();

        const target = event.target as HTMLElement;
        const settingEl = target.closest('.setting-item') as HTMLElement;
    }

    onDrop(event: DragEvent) {
        event.preventDefault();
        const draggedId = event.dataTransfer?.getData('text/plain');
        const dropTarget = (event.target as HTMLElement).closest('.setting-item') as HTMLElement;

        if (draggedId && dropTarget) {
            const draggedIndex = this.propertyList.findIndex(p => p.id === draggedId);
            const dropIndex = Array.from(this.listSectionEl.children).indexOf(dropTarget);

            if (draggedIndex !== -1 && dropIndex !== -1 && draggedIndex !== dropIndex) {
                const [draggedItem] = this.propertyList.splice(draggedIndex, 1);
                this.propertyList.splice(dropIndex, 0, draggedItem);
                this.refreshView();
            }
        }
    }

    updateAddSection() {
        this.addSectionEl.empty();

        new Setting(this.addSectionEl)
            .setName('Add New Property')
            .addText(text => {
                this.addInputEl = text.onChange(value => this.newAddName = value).inputEl;
                this.addInputEl.addEventListener('keydown', (event: KeyboardEvent) => {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        this.addNewProperty();
                    }
                })
            })
            .addButton(button => button
                .setButtonText('Add')
                .setCta()
                .onClick(() => this.addNewProperty()));
    }

    addNewProperty() {
        const newAddName = this.newAddName.trim();
        if (newAddName && !this.propertyList.some(p => p.key === newAddName)) {
            this.propertyList.push({
                id: crypto.randomUUID(),
                key: newAddName,
                value: '',
                type: 'Text'
            });
            this.refreshView();
            this.newAddName = '';
            (this.addSectionEl.querySelector('input') as HTMLInputElement).value = '';
        }
    }

    updateSaveSection() {
        this.saveSectionEl.empty();
        const setting = new Setting(this.saveSectionEl);

        if (this.plugin.frontmatterLists.length) {
            setting.addButton(button => button
                .setButtonText('Save')
                .setCta()
                .onClick(() => {
                    new ConfirmationModal(this.app,
                        'Confirm Save', 
                        'This will update the properties of all selected files.\nThis operation is irreversible, are you sure you want to save all the changes?', 
                        'Confirm',
                        async () => {
                            this.close();
                            await this.plugin.updateMarkdownFiles(this.fileList, this.propertyList);
                        }
                    ).open();
                }));
        } else {
            setting.addButton(button => button
                .setButtonText('Close')
                .setCta()
                .onClick(() => this.close()));
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class RenamePropertyModal extends Modal {
    oldName: string;
    newName: string;
    renameInputEl: HTMLElement;
    onRename: (newName: string) => void;

    constructor(app: App, oldName: string, onRename: (newName: string) => void) {
        super(app);
        this.oldName = oldName;
        this.onRename = onRename;
    }

    onOpen() {
        const { contentEl } = this;

        contentEl.createEl('h4', { text: 'Rename Property' });

        new Setting(contentEl)
            .setName('Enter New Property Name')
            .addText(text => {
                this.renameInputEl = text.setValue(this.oldName).onChange(value => this.newName = value).inputEl;
                this.renameInputEl.addEventListener('keydown', (event: KeyboardEvent) => {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        this.onRename(this.newName);
                        this.close();
                    }
                });
            });

        new Setting(contentEl)
            .addButton(button => button
                .setButtonText('Confirm')
                .setCta()
                .onClick(() => {
                    this.onRename(this.newName);
                    this.close();
                }))
            .addButton(button => button
                .setButtonText('Cancel')
                .onClick(() => {
                    this.close();
                }));
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class ConfirmationModal extends Modal {
    private onConfirm: () => void;
    private title: string;
    private message: string;
    private confirmText: string;

    constructor(app: App, title: string, message: string, confirmText: string, onConfirm: () => void) {
        super(app);
        this.title = title;
        this.message = message;
        this.confirmText = confirmText;
        this.onConfirm = onConfirm;
    }

    onOpen() {
        const { contentEl } = this;

        contentEl.createEl('h4', { text: this.title });
        contentEl.createEl('p', { text: this.message, cls: 'dbp-info' });

        new Setting(contentEl)
            .addButton(button => button
                .setButtonText('Cancel')
                .onClick(() => this.close()))
            .addButton(button => button
                .setButtonText(this.confirmText)
                .setCta()
                .onClick(() => {
                    this.onConfirm();
                    this.close();
                }));
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
    getItems(): TFolder[] {
        return this.app.vault.getAllLoadedFiles()
            .filter((file): file is TFolder => file instanceof TFolder);
    }

    getItemText(item: TFolder): string {
        return item.path;
    }

    onChooseItem(item: TFolder, evt: MouseEvent | KeyboardEvent): void {
        this.onSelect(item.path);
    }

    constructor(app: App, onSelect: (folder: string) => void) {
        super(app);
        this.onSelect = onSelect;
    }

    onSelect: (folder: string) => void;
}

class TagSuggestModal extends FuzzySuggestModal<string> {
    getItems(): string[] {
        const tagSet = new Set<string>();
        this.app.vault.getMarkdownFiles().forEach(file => {
            const cache = this.app.metadataCache.getFileCache(file);
            if (cache) {
                // 检查内联标签
                if (cache.tags) {
                    // 移除 '#' 前缀
                    cache.tags.forEach(tag => tagSet.add(tag.tag.slice(1)));
                }
                // 检查 frontmatter 中的标签
                if (cache.frontmatter && cache.frontmatter.tags) {
                    const fmTags = cache.frontmatter.tags;
                    if (Array.isArray(fmTags)) {
                        // 移除可能的 '#' 前缀
                        fmTags.forEach(tag => tagSet.add(tag.replace(/^#/, '')));
                    } else if (typeof fmTags === 'string') {
                        // 移除可能的 '#' 前缀
                        tagSet.add(fmTags.replace(/^#/, ''));
                    }
                }
            }
        });
        return Array.from(tagSet);
    }

    getItemText(item: string): string {
        return item;
    }

    onChooseItem(item: string, evt: MouseEvent | KeyboardEvent): void {
        this.onSelect(item);
    }

    constructor(app: App, onSelect: (tag: string) => void) {
        super(app);
        this.onSelect = onSelect;
    }

    onSelect: (tag: string) => void;
}
