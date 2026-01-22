const VIEW_TYPE_OLLAMA = 'ollama-side-view';

const DEFAULT_SETTINGS = {
    ollamaUrl: 'http://localhost:11434',
    defaultModel: 'llama3.1:8b',
    temperature: 0.7,
    maxTokens: -1,
    autoStart: false,
    chatHistoryPath: 'Ollama Chats/',
    includeNoteContext: true
};

module.exports = {
    VIEW_TYPE_OLLAMA,
    DEFAULT_SETTINGS
};
