const { PluginSettingTab, Setting } = require('obsidian');

class OllamaSettingsTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Ollama Sidechat Settings' });

        // Connection section
        containerEl.createEl('h3', { text: 'Connection' });

        new Setting(containerEl)
            .setName('Ollama Status')
            .setDesc(this.plugin.isOllamaRunning ? '● Service is running' : '○ Service is stopped')
            .addButton(button => {
                button.setButtonText(this.plugin.isOllamaRunning ? 'Stop Service' : 'Start Service');
                button.onClick(async () => {
                    await this.plugin.toggleOllamaService();
                    this.display();
                });
            });

        new Setting(containerEl)
            .setName('Auto-start Ollama')
            .setDesc('Automatically check Ollama status on plugin startup')
            .addToggle(toggle => {
                toggle.setValue(this.plugin.settings.autoStart);
                toggle.onChange(async (value) => {
                    this.plugin.settings.autoStart = value;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName('Ollama URL')
            .setDesc('URL of your Ollama instance')
            .addText(text => {
                text.setPlaceholder('http://localhost:11434')
                    .setValue(this.plugin.settings.ollamaUrl)
                    .onChange(async (value) => {
                        this.plugin.settings.ollamaUrl = value;
                        await this.plugin.saveSettings();
                    });
            });

        // Model section
        containerEl.createEl('h3', { text: 'Model Settings' });

        new Setting(containerEl)
            .setName('Default Model')
            .setDesc('Default model to use for chat')
            .addText(text => {
                text.setPlaceholder('llama3.1')
                    .setValue(this.plugin.settings.defaultModel)
                    .onChange(async (value) => {
                        this.plugin.settings.defaultModel = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName('Temperature')
            .setDesc('Model temperature (0.0 - 1.0). Higher = more creative, lower = more focused.')
            .addSlider(slider => {
                slider.setLimits(0, 1, 0.1)
                    .setValue(this.plugin.settings.temperature)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.temperature = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName('Max Tokens')
            .setDesc('Maximum tokens per response. Use -1 or 0 for unlimited (model decides).')
            .addText(text => {
                text.setPlaceholder('-1')
                    .setValue(this.plugin.settings.maxTokens.toString())
                    .onChange(async (value) => {
                        const parsed = parseInt(value);
                        this.plugin.settings.maxTokens = isNaN(parsed) ? -1 : parsed;
                        await this.plugin.saveSettings();
                    });
            });

        // Chat History section
        containerEl.createEl('h3', { text: 'Chat History' });

        new Setting(containerEl)
            .setName('Chat History Folder')
            .setDesc('Folder path where chat history will be saved (relative to vault root, use forward slashes)')
            .addText(text => {
                text.setPlaceholder('Ollama Chats/')
                    .setValue(this.plugin.settings.chatHistoryPath)
                    .onChange(async (value) => {
                        // Normalize path - replace backslashes, ensure ends with /
                        value = (value || 'Ollama Chats/').replace(/\\/g, '/');
                        if (!value.endsWith('/')) {
                            value = value + '/';
                        }
                        this.plugin.settings.chatHistoryPath = value;
                        await this.plugin.saveSettings();
                        await this.plugin.ensureChatHistoryFolder();
                    });
            });

        new Setting(containerEl)
            .setName('Include Note Context')
            .setDesc('Automatically include the content of the active note as context for your questions')
            .addToggle(toggle => {
                toggle.setValue(this.plugin.settings.includeNoteContext);
                toggle.onChange(async (value) => {
                    this.plugin.settings.includeNoteContext = value;
                    await this.plugin.saveSettings();
                });
            });
    }
}

module.exports = OllamaSettingsTab;
