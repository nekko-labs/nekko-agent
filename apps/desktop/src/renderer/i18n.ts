import { useStore } from './store.js';

/** Languages we ship UI translations for. */
export const LANGUAGES = [
  { code: 'en', label: 'English', badge: 'EN' },
  { code: 'es', label: 'Español', badge: 'ES' },
  { code: 'fr', label: 'Français', badge: 'FR' },
  { code: 'de', label: 'Deutsch', badge: 'DE' },
  { code: 'pt', label: 'Português', badge: 'PT' },
  { code: 'ja', label: '日本語', badge: 'あ' },
  { code: 'zh', label: '简体中文', badge: '中' },
] as const;

export type Language = typeof LANGUAGES[number]['code'];
const languageCodes: ReadonlySet<string> = new Set(LANGUAGES.map(({ code }) => code));
export const isLanguage = (value: string): value is Language => languageCodes.has(value);

// An empty string survives the settings JSON transport and means follow the system.
export const languagePatch = (value: Language | '') => ({ language: value });

// English defines the keys each shipped locale must provide.
const en = {
  'settings.languageAndHelp': 'Language and help',
  'settings.showTips': 'Show tips',
  'settings.setupWizard': 'Setup wizard',
  'settings.setupWizardHint': 'Reopen the first-run walkthrough.',
  'settings.replaySetup': 'Replay setup',
  'settings.general': 'General',
  'nav.breadcrumb': 'Breadcrumb',
  'nav.command': 'Agents',
  'nav.artifacts': 'Library',
  'nav.design': 'Design',
  'nav.skills': 'Skills',
  'nav.training': 'Training',
  'nav.workflows': 'Automations',
  'nav.models': 'Models',
  'nav.modelserver': 'Model Server',
  'nav.connectors': 'Connectors',
  'nav.memory': 'Memory',
  'nav.settings': 'Settings',
  'nav.feedback': 'Send feedback',

  'settings.title': 'Settings',
  'settings.appearance': 'Appearance',
  'settings.theme': 'Theme',
  'settings.accent': 'Accent color',
  'settings.accent2': 'Secondary color',
  'settings.themeAuto': 'Auto',
  'settings.themeLight': 'Light',
  'settings.themeDark': 'Dark',
  'settings.customColors': 'Custom colors',
  'settings.customColorsHint': 'Tune the accent and gradient with a color wheel.',
  'settings.customColorsOn': 'Custom accent applied on top of this theme.',
  'settings.systemPicker': 'System color picker',
  'settings.resetColors': "Reset to this theme's colors",
  'settings.mascot': 'Show Nekko mascot',
  'settings.language': 'Language',
  'settings.languageHint': 'Choose the interface language (defaults to your system).',
  'settings.systemDefault': 'System default',
  'settings.updates': 'Updates',
  'settings.checkAuto': 'Check for updates automatically',
  'settings.checkNow': 'Check now',
  'settings.sandbox': 'Sandbox',
  'settings.chatModes': 'Chat modes',
  'settings.guardrails': 'Guardrails',

  'theme.light': 'light',
  'theme.dark': 'dark',
  'theme.system': 'system',
};

type Dict = Record<keyof typeof en, string>;

const es: Dict = {
  'nav.breadcrumb': 'Ruta de navegación',
  'nav.artifacts': 'Biblioteca',
  'nav.design': 'Diseño',
  'nav.skills': 'Habilidades',
  'nav.training': 'Entrenamiento',
  'nav.workflows': 'Automatizaciones',
  'settings.languageAndHelp': 'Idioma y ayuda',
  'settings.showTips': 'Mostrar sugerencias',
  'settings.setupWizard': 'Asistente de configuración',
  'settings.setupWizardHint': 'Vuelve a abrir la guía de inicio.',
  'settings.replaySetup': 'Repetir configuración',
  'settings.general': 'General',
  'nav.command': 'Agentes',
  'nav.models': 'Modelos',
  'nav.modelserver': 'Servidor de modelos',
  'nav.connectors': 'Conectores',
  'nav.memory': 'Memoria',
  'nav.settings': 'Ajustes',
  'nav.feedback': 'Enviar comentarios',
  'settings.title': 'Ajustes',
  'settings.appearance': 'Apariencia',
  'settings.theme': 'Tema',
  'settings.accent': 'Color de acento',
  'settings.accent2': 'Color secundario',
  'settings.themeAuto': 'Automático',
  'settings.themeLight': 'Claro',
  'settings.themeDark': 'Oscuro',
  'settings.customColors': 'Colores personalizados',
  'settings.customColorsHint': 'Ajusta el acento y el degradado con una rueda de color.',
  'settings.customColorsOn': 'Acento personalizado aplicado sobre este tema.',
  'settings.systemPicker': 'Selector de color del sistema',
  'settings.resetColors': 'Restablecer los colores del tema',
  'settings.mascot': 'Mostrar la mascota Nekko',
  'settings.language': 'Idioma',
  'settings.languageHint': 'Elige el idioma de la interfaz (por defecto, el del sistema).',
  'settings.systemDefault': 'Predeterminado del sistema',
  'settings.updates': 'Actualizaciones',
  'settings.checkAuto': 'Buscar actualizaciones automáticamente',
  'settings.checkNow': 'Buscar ahora',
  'settings.sandbox': 'Entorno aislado',
  'settings.chatModes': 'Modos de chat',
  'settings.guardrails': 'Salvaguardas',
  'theme.light': 'claro',
  'theme.dark': 'oscuro',
  'theme.system': 'sistema',
};

const fr: Dict = {
  'nav.breadcrumb': 'Fil d’Ariane',
  'nav.artifacts': 'Bibliothèque',
  'nav.design': 'Design',
  'nav.skills': 'Compétences',
  'nav.training': 'Entraînement',
  'nav.workflows': 'Automatisations',
  'settings.languageAndHelp': 'Langue et aide',
  'settings.showTips': 'Afficher les astuces',
  'settings.setupWizard': 'Assistant de configuration',
  'settings.setupWizardHint': 'Rouvrir la visite guidée de démarrage.',
  'settings.replaySetup': 'Reprendre la configuration',
  'settings.general': 'Général',
  'nav.command': 'Agents',
  'nav.models': 'Modèles',
  'nav.modelserver': 'Serveur de modèles',
  'nav.connectors': 'Connecteurs',
  'nav.memory': 'Mémoire',
  'nav.settings': 'Paramètres',
  'nav.feedback': 'Envoyer un avis',
  'settings.title': 'Paramètres',
  'settings.appearance': 'Apparence',
  'settings.theme': 'Thème',
  'settings.accent': "Couleur d'accent",
  'settings.accent2': 'Couleur secondaire',
  'settings.themeAuto': 'Auto',
  'settings.themeLight': 'Clair',
  'settings.themeDark': 'Sombre',
  'settings.customColors': 'Couleurs personnalisées',
  'settings.customColorsHint': "Ajustez l'accent et le dégradé avec une roue chromatique.",
  'settings.customColorsOn': 'Accent personnalisé appliqué sur ce thème.',
  'settings.systemPicker': 'Sélecteur de couleur du système',
  'settings.resetColors': 'Rétablir les couleurs du thème',
  'settings.mascot': 'Afficher la mascotte Nekko',
  'settings.language': 'Langue',
  'settings.languageHint': "Choisissez la langue de l'interface (système par défaut).",
  'settings.systemDefault': 'Par défaut du système',
  'settings.updates': 'Mises à jour',
  'settings.checkAuto': 'Vérifier les mises à jour automatiquement',
  'settings.checkNow': 'Vérifier maintenant',
  'settings.sandbox': 'Bac à sable',
  'settings.chatModes': 'Modes de discussion',
  'settings.guardrails': 'Garde-fous',
  'theme.light': 'clair',
  'theme.dark': 'sombre',
  'theme.system': 'système',
};

const de: Dict = {
  'nav.breadcrumb': 'Navigationspfad',
  'nav.artifacts': 'Bibliothek',
  'nav.design': 'Design',
  'nav.skills': 'Fähigkeiten',
  'nav.training': 'Training',
  'nav.workflows': 'Automatisierungen',
  'settings.languageAndHelp': 'Sprache und Hilfe',
  'settings.showTips': 'Tipps anzeigen',
  'settings.setupWizard': 'Einrichtungsassistent',
  'settings.setupWizardHint': 'Die Einführung erneut öffnen.',
  'settings.replaySetup': 'Einrichtung wiederholen',
  'settings.general': 'Allgemein',
  'nav.command': 'Agenten',
  'nav.models': 'Modelle',
  'nav.modelserver': 'Modellserver',
  'nav.connectors': 'Konnektoren',
  'nav.memory': 'Speicher',
  'nav.settings': 'Einstellungen',
  'nav.feedback': 'Feedback senden',
  'settings.title': 'Einstellungen',
  'settings.appearance': 'Darstellung',
  'settings.theme': 'Design',
  'settings.accent': 'Akzentfarbe',
  'settings.accent2': 'Sekundärfarbe',
  'settings.themeAuto': 'Automatisch',
  'settings.themeLight': 'Hell',
  'settings.themeDark': 'Dunkel',
  'settings.customColors': 'Eigene Farben',
  'settings.customColorsHint': 'Akzent und Verlauf über ein Farbrad einstellen.',
  'settings.customColorsOn': 'Eigener Akzent über diesem Theme.',
  'settings.systemPicker': 'System-Farbwähler',
  'settings.resetColors': 'Farben des Themes zurücksetzen',
  'settings.mascot': 'Nekko-Maskottchen anzeigen',
  'settings.language': 'Sprache',
  'settings.languageHint': 'Sprache der Oberfläche wählen (Standard: System).',
  'settings.systemDefault': 'Systemstandard',
  'settings.updates': 'Aktualisierungen',
  'settings.checkAuto': 'Automatisch nach Updates suchen',
  'settings.checkNow': 'Jetzt suchen',
  'settings.sandbox': 'Sandbox',
  'settings.chatModes': 'Chat-Modi',
  'settings.guardrails': 'Schutzregeln',
  'theme.light': 'hell',
  'theme.dark': 'dunkel',
  'theme.system': 'System',
};

const pt: Dict = {
  'nav.breadcrumb': 'Caminho de navegação',
  'nav.artifacts': 'Biblioteca',
  'nav.design': 'Design',
  'nav.skills': 'Habilidades',
  'nav.training': 'Treinamento',
  'nav.workflows': 'Automações',
  'settings.languageAndHelp': 'Idioma e ajuda',
  'settings.showTips': 'Mostrar dicas',
  'settings.setupWizard': 'Assistente de configuração',
  'settings.setupWizardHint': 'Reabra o guia de primeiros passos.',
  'settings.replaySetup': 'Refazer configuração',
  'settings.general': 'Geral',
  'nav.command': 'Agentes',
  'nav.models': 'Modelos',
  'nav.modelserver': 'Servidor de modelos',
  'nav.connectors': 'Conectores',
  'nav.memory': 'Memória',
  'nav.settings': 'Configurações',
  'nav.feedback': 'Enviar feedback',
  'settings.title': 'Configurações',
  'settings.appearance': 'Aparência',
  'settings.theme': 'Tema',
  'settings.accent': 'Cor de destaque',
  'settings.accent2': 'Cor secundária',
  'settings.themeAuto': 'Automático',
  'settings.themeLight': 'Claro',
  'settings.themeDark': 'Escuro',
  'settings.customColors': 'Cores personalizadas',
  'settings.customColorsHint': 'Ajuste o destaque e o gradiente com uma roda de cores.',
  'settings.customColorsOn': 'Destaque personalizado aplicado sobre este tema.',
  'settings.systemPicker': 'Seletor de cores do sistema',
  'settings.resetColors': 'Restaurar as cores do tema',
  'settings.mascot': 'Mostrar o mascote Nekko',
  'settings.language': 'Idioma',
  'settings.languageHint': 'Escolha o idioma da interface (padrão do sistema).',
  'settings.systemDefault': 'Padrão do sistema',
  'settings.updates': 'Atualizações',
  'settings.checkAuto': 'Verificar atualizações automaticamente',
  'settings.checkNow': 'Verificar agora',
  'settings.sandbox': 'Sandbox',
  'settings.chatModes': 'Modos de conversa',
  'settings.guardrails': 'Proteções',
  'theme.light': 'claro',
  'theme.dark': 'escuro',
  'theme.system': 'sistema',
};

const ja: Dict = {
  'nav.breadcrumb': 'パンくずリスト',
  'nav.artifacts': 'ライブラリ',
  'nav.design': 'デザイン',
  'nav.skills': 'スキル',
  'nav.training': 'トレーニング',
  'nav.workflows': '自動化',
  'settings.languageAndHelp': '言語とヘルプ',
  'settings.showTips': 'ヒントを表示',
  'settings.setupWizard': 'セットアップウィザード',
  'settings.setupWizardHint': '初回セットアップの案内を開き直します。',
  'settings.replaySetup': 'セットアップをやり直す',
  'settings.general': '一般',
  'nav.command': 'エージェント',
  'nav.models': 'モデル',
  'nav.modelserver': 'モデルサーバー',
  'nav.connectors': 'コネクタ',
  'nav.memory': 'メモリ',
  'nav.settings': '設定',
  'nav.feedback': 'フィードバックを送信',
  'settings.title': '設定',
  'settings.appearance': '外観',
  'settings.theme': 'テーマ',
  'settings.accent': 'アクセントカラー',
  'settings.accent2': 'セカンダリカラー',
  'settings.themeAuto': '自動',
  'settings.themeLight': 'ライト',
  'settings.themeDark': 'ダーク',
  'settings.customColors': 'カスタムカラー',
  'settings.customColorsHint': 'カラーホイールでアクセントとグラデーションを調整します。',
  'settings.customColorsOn': 'このテーマにカスタムアクセントを適用中。',
  'settings.systemPicker': 'システムのカラーピッカー',
  'settings.resetColors': 'テーマの色に戻す',
  'settings.mascot': 'Nekko マスコットを表示',
  'settings.language': '言語',
  'settings.languageHint': 'インターフェースの言語を選択（既定はシステム）。',
  'settings.systemDefault': 'システムの既定',
  'settings.updates': 'アップデート',
  'settings.checkAuto': '自動でアップデートを確認',
  'settings.checkNow': '今すぐ確認',
  'settings.sandbox': 'サンドボックス',
  'settings.chatModes': 'チャットモード',
  'settings.guardrails': 'ガードレール',
  'theme.light': 'ライト',
  'theme.dark': 'ダーク',
  'theme.system': 'システム',
};

const zh: Dict = {
  'nav.breadcrumb': '面包屑导航',
  'nav.artifacts': '资料库',
  'nav.design': '设计',
  'nav.skills': '技能',
  'nav.training': '训练',
  'nav.workflows': '自动化',
  'settings.languageAndHelp': '语言和帮助',
  'settings.showTips': '显示提示',
  'settings.setupWizard': '设置向导',
  'settings.setupWizardHint': '重新打开首次使用指南。',
  'settings.replaySetup': '重新运行设置',
  'settings.general': '常规',
  'nav.command': '智能体',
  'nav.models': '模型',
  'nav.modelserver': '模型服务器',
  'nav.connectors': '连接器',
  'nav.memory': '记忆',
  'nav.settings': '设置',
  'nav.feedback': '发送反馈',
  'settings.title': '设置',
  'settings.appearance': '外观',
  'settings.theme': '主题',
  'settings.accent': '强调色',
  'settings.accent2': '辅助色',
  'settings.themeAuto': '自动',
  'settings.themeLight': '浅色',
  'settings.themeDark': '深色',
  'settings.customColors': '自定义颜色',
  'settings.customColorsHint': '用色轮调整强调色与渐变。',
  'settings.customColorsOn': '已在该主题上应用自定义强调色。',
  'settings.systemPicker': '系统取色器',
  'settings.resetColors': '恢复该主题的颜色',
  'settings.mascot': '显示 Nekko 吉祥物',
  'settings.language': '语言',
  'settings.languageHint': '选择界面语言（默认跟随系统）。',
  'settings.systemDefault': '系统默认',
  'settings.updates': '更新',
  'settings.checkAuto': '自动检查更新',
  'settings.checkNow': '立即检查',
  'settings.sandbox': '沙盒',
  'settings.chatModes': '聊天模式',
  'settings.guardrails': '防护规则',
  'theme.light': '浅色',
  'theme.dark': '深色',
  'theme.system': '系统',
};

const DICTS: Record<Language, Dict> = { en, es, fr, de, pt, ja, zh };

function preferredLanguages(): readonly string[] {
  const native = typeof window === 'undefined' ? undefined : window.nekkoChrome?.systemLanguages;
  if (native?.length) return native;
  return typeof navigator === 'undefined' ? [] : [...(navigator.languages ?? []), navigator.language];
}

export function supportedLanguage(tag?: string): Language | undefined {
  const base = tag?.trim().toLowerCase().split(/[-_]/)[0];
  return base && isLanguage(base) ? base : undefined;
}

/** An explicit choice wins, then the first supported computer language, then English. */
export function resolveLang(setting?: string, preferences = preferredLanguages()): Language {
  const explicit = supportedLanguage(setting);
  if (explicit) return explicit;
  for (const preference of preferences) {
    const system = supportedLanguage(preference);
    if (system) return system;
  }
  return 'en';
}

export function useLanguage(): Language {
  return resolveLang(useStore((s) => s.settings?.language));
}

export function syncDocumentLanguage() {
  const apply = (setting?: string) => {
    const next = resolveLang(setting);
    if (document.documentElement.lang !== next) document.documentElement.lang = next;
  };
  apply(useStore.getState().settings?.language);
  return useStore.subscribe((state, prev) => {
    if (state.settings?.language !== prev.settings?.language) apply(state.settings?.language);
  });
}

export type MessageKey = keyof Dict;

export function translate(lang: string, key: string): string {
  const dict = isLanguage(lang) ? DICTS[lang] : en;
  return Object.hasOwn(dict, key) ? dict[key as MessageKey] : key;
}

/** Hook: returns a `t(key)` bound to the user's current language. */
export function useT(): (key: MessageKey) => string {
  const lang = useLanguage();
  return (key: MessageKey) => translate(lang, key);
}
