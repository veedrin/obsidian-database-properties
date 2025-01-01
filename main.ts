import { App, Plugin, Setting, TFile, TFolder, Modal, FuzzySuggestModal, getAllTags, Notice } from 'obsidian';

interface Property {
    id: string;
    key: string;
    value: any;
    type: string;
    types?: Set<string>;
}

export default class DatabaseProperties extends Plugin {

    frontmatterLists: Array<Property>[] = [];
    wikiLinkPattern = /^\[\[.*\]\]$/;

    async onload() {
        this.addRibbonIcon('list-minus', 'Database Properties', () => new DatabasePropertiesModal(this.app, this).open());

        this.addCommand({
            id: 'open',
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

            const tags = getAllTags(cache);
            return tags?.some(t => t === tag) || false;
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
                            value: null,
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

    async batchWriteFrontmatter(fileList: TFile[], propertyList: Property[]) {
        const notice = new Notice('开始处理...', 0);
        const length = fileList.length;

        for (let i = 0; i < length; i++) {
            notice.setMessage(`处理进度：${i + 1} / ${length}`);
            const frontmatterList = this.frontmatterLists[i];
        
            await this.app.fileManager.processFrontMatter(fileList[i], (frontmatter) => {
                // 清空当前的属性
                Object.keys(frontmatter).forEach(key => {
                    delete frontmatter[key];
                });
            
                // 添加新的属性
                propertyList.forEach(prop => {
                    const found = frontmatterList.find(fm => fm.id === prop.id) || prop;
                    frontmatter[prop.key] = found.value;
                });
            });
        }

        notice.hide();
    }
}

// 主弹窗
class DatabasePropertiesModal extends Modal {

    plugin: DatabaseProperties;
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

    constructor(app: App, plugin: DatabaseProperties) {
        super(app);
        this.plugin = plugin;
    }

    async onOpen() {

        const { contentEl } = this;
        contentEl.empty();

        new Setting(contentEl).setName('Database Properties').setHeading();

        this.selectSectionEl = contentEl.createEl('div', { cls: 'dbp-section' });
        this.listSectionEl = contentEl.createEl('div', { cls: 'dbp-section dbp-draggable-list' });
        this.addSectionEl = contentEl.createEl('div', { cls: 'dbp-section' });
        this.saveSectionEl = contentEl.createEl('div', { cls: 'dbp-section' });

        const setting = new Setting(this.selectSectionEl)
            .setName('选择数据库文件')
            .addButton(button => button
                .setButtonText('通过目录')
                .onClick(async () => {
                    new FolderSuggestModal(this.app, async (folder) => {
                        this.fileList = await this.plugin.getFilesByFolder(folder);
                        await this.initializeView();
                        setting.setName(`选中目录：${folder}`);
                    }).open();
                }))
            .addButton(button => button
                .setButtonText('通过标签')
                .onClick(async () => {
                    new TagSuggestModal(this.app, async (tag) => {
                        this.fileList = await this.plugin.getFilesByTag(tag);
                        await this.initializeView();
                        setting.setName(`选中标签：${tag}`);
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
            const setting = new Setting(this.listSectionEl).setName(prop.key).setDesc(`数据类型：${prop.type}`);

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
                    .setTooltip('属性改名')
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
                .setTooltip('属性删除')
                .onClick(() => {
                    new ConfirmationModal(this.app, 
                        '删除确认', 
                        `确定要删除属性 "${prop.key}" 吗？`, 
                        '确认',
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
            .setName('属性添加')
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
                .setButtonText('添加')
                .setCta()
                .onClick(() => this.addNewProperty()));
    }

    addNewProperty() {
        const newAddName = this.newAddName.trim();
        if (newAddName && !this.propertyList.some(p => p.key === newAddName)) {
            this.propertyList.push({
                id: crypto.randomUUID(),
                key: newAddName,
                value: null,
                type: 'Null'
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
                .setButtonText('保存')
                .setCta()
                .onClick(() => {
                    new ConfirmationModal(this.app,
                        '保存确认', 
                        '这将更新所有选中文件的属性，此操作不可撤销，确定保存吗？', 
                        '确认',
                        async () => {
                            this.close();
                            await this.plugin.batchWriteFrontmatter(this.fileList, this.propertyList);
                        }
                    ).open();
                }));
        } else {
            setting.addButton(button => button
                .setButtonText('关闭')
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

        new Setting(contentEl).setName('属性改名').setHeading();
        new Setting(contentEl)
            .setName('输入新属性名')
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
                .setButtonText('确认')
                .setCta()
                .onClick(() => {
                    this.onRename(this.newName);
                    this.close();
                }))
            .addButton(button => button
                .setButtonText('取消')
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

        new Setting(contentEl).setName(this.title).setHeading();
        contentEl.createEl('p', { text: this.message, cls: 'dbp-info' });

        new Setting(contentEl)
            .addButton(button => button
                .setButtonText('取消')
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
                const tags = getAllTags(cache);
                tags?.forEach(tag => tagSet.add(tag));
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
