import { App, PluginSettingTab, Setting } from 'obsidian';
import OllamaPlugin from './main';

export class OllamaSettingsTab extends PluginSettingTab {
    plugin: OllamaPlugin;

    constructor(app: App, plugin: OllamaPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // Status indicator
        new Setting(containerEl)
            .setName('Ollama Status')
            .setDesc(this.plugin.isOllamaRunning ? '● Service is running' : '○ Service is stopped')
            .addButton(button => button
                .setButtonText(this.plugin.isOllamaRunning ? 'Stop Service' : 'Start Service')
                .onClick(async () => {
                    await this.plugin.toggleOllamaService();
                    this.display(); // Refresh the settings tab
                }));

        new Setting(containerEl)
            .setName('Auto-start Ollama')
            .setDesc('Automatically check Ollama status on plugin startup')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoStart)
                .onChange(async (value) => {
                    this.plugin.settings.autoStart = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Ollama URL')
            .setDesc('URL of your Ollama instance (default: http://localhost:11434)')
            .addText(text => text
                .setPlaceholder('http://localhost:11434')
                .setValue(this.plugin.settings.ollamaUrl)
                .onChange(async (value) => {
                    this.plugin.settings.ollamaUrl = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Default Model')
            .setDesc('Default model to use for chat')
            .addText(text => text
                .setPlaceholder('llama3.1')
                .setValue(this.plugin.settings.defaultModel)
                .onChange(async (value) => {
                    this.plugin.settings.defaultModel = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Temperature')
            .setDesc('Model temperature (0.0 - 1.0)')
            .addSlider(slider => slider
                .setLimits(0, 1, 0.1)
                .setValue(this.plugin.settings.temperature)
                .onChange(async (value) => {
                    this.plugin.settings.temperature = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Max Tokens')
            .setDesc('Maximum tokens to generate')
            .addText(text => text
                .setPlaceholder('1000')
                .setValue(this.plugin.settings.maxTokens.toString())
                .onChange(async (value) => {
                    this.plugin.settings.maxTokens = parseInt(value) || 1000;
                    await this.plugin.saveSettings();
                }));
    }
}
