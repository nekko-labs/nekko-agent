import { useCallback } from 'react';
import { useLanguage, type Language } from './i18n.js';

type Localized = Record<Language, string>;
const text = (en: string, es: string, fr: string, de: string, pt: string, ja: string, zh: string): Localized => ({ en, es, fr, de, pt, ja, zh });

export const onboardingMessages = {
  'step.welcome': text('Welcome', 'Bienvenida', 'Bienvenue', 'Willkommen', 'Boas-vindas', 'ようこそ', '欢迎'),
  'step.name': text('Name', 'Nombre', 'Nom', 'Name', 'Nome', '名前', '姓名'),
  'step.email': text('Email', 'Correo electrónico', 'Adresse e-mail', 'E-Mail', 'E-mail', 'メール', '电子邮件'),
  'step.work': text('Your work', 'Tu trabajo', 'Votre activité', 'Deine Arbeit', 'Seu trabalho', '普段の作業', '你的工作'),
  'step.detail': text('Detail', 'Nivel de detalle', 'Niveau de détail', 'Detailgrad', 'Nível de detalhe', '表示する情報', '详细程度'),
  'step.theme': text('Look', 'Apariencia', 'Apparence', 'Aussehen', 'Aparência', '外観', '外观'),
  'step.providers': text('Providers', 'Proveedores', 'Fournisseurs', 'Anbieter', 'Provedores', 'プロバイダー', '提供商'),
  'step.dictation': text('Dictation', 'Dictado', 'Dictée', 'Diktat', 'Ditado', '音声入力', '语音输入'),
  'step.integrations': text('Integrations', 'Integraciones', 'Intégrations', 'Integrationen', 'Integrações', '連携', '集成'),
  'step.tracking': text('Work tracking', 'Seguimiento del trabajo', 'Suivi du travail', 'Arbeitsverfolgung', 'Acompanhamento do trabalho', '作業の追跡', '工作跟踪'),
  'step.help': text('Help improve', 'Ayuda a mejorar', 'Aider à améliorer', 'Bei der Verbesserung helfen', 'Ajude a melhorar', '改善への協力', '帮助改进'),
  'step.done': text('All set', 'Todo listo', 'Tout est prêt', 'Alles bereit', 'Tudo pronto', '設定完了', '设置完成'),
  setup: text('Nekko Agent setup', 'Configuración de Nekko Agent', 'Configuration de Nekko Agent', 'Nekko Agent einrichten', 'Configuração do Nekko Agent', 'Nekko Agent のセットアップ', 'Nekko Agent 设置'),
  progress: text('Setup progress', 'Progreso de la configuración', 'Progression de la configuration', 'Einrichtungsfortschritt', 'Progresso da configuração', 'セットアップの進行状況', '设置进度'),
  stepCount: text('Step {index} of {total}: {title}', 'Paso {index} de {total}: {title}', 'Étape {index} sur {total} : {title}', 'Schritt {index} von {total}: {title}', 'Etapa {index} de {total}: {title}', '{total} ステップ中 {index}：{title}', '第 {index} 步，共 {total} 步：{title}'),
  skipSetup: text('Skip setup', 'Omitir configuración', 'Ignorer la configuration', 'Einrichtung überspringen', 'Pular configuração', '設定をスキップ', '跳过设置'),
  skipStep: text('Skip step', 'Omitir paso', 'Ignorer cette étape', 'Schritt überspringen', 'Pular etapa', 'この手順をスキップ', '跳过此步'),
  back: text('Back', 'Atrás', 'Retour', 'Zurück', 'Voltar', '戻る', '返回'),
  next: text('Next', 'Siguiente', 'Suivant', 'Weiter', 'Avançar', '次へ', '下一步'),
  finish: text('Finish', 'Finalizar', 'Terminer', 'Fertig', 'Concluir', '完了', '完成'),
  start: text("Let's go", 'Empezar', 'C’est parti', 'Los geht’s', 'Vamos lá', 'はじめる', '开始'),
  noThanks: text('No thanks', 'No, gracias', 'Non merci', 'Nein, danke', 'Não, obrigado', '登録しない', '不用了'),
  hi: text('Hi!', '¡Hola!', 'Salut !', 'Hallo!', 'Olá!', 'こんにちは！', '你好！'),
  welcome: text("Hi, I'm Nekko.", 'Hola, soy Nekko.', 'Bonjour, je suis Nekko.', 'Hallo, ich bin Nekko.', 'Olá, eu sou o Nekko.', 'こんにちは、Nekko です。', '你好，我是 Nekko。'),
  welcomeBody: text("I'm the agent that lives on your computer. Answer a few quick questions and I'll set myself up the way you like to work.", 'Soy el agente que vive en tu computadora. Responde unas preguntas y me adaptaré a tu forma de trabajar.', 'Je suis l’agent qui vit sur votre ordinateur. Répondez à quelques questions et je m’adapterai à votre façon de travailler.', 'Ich bin der Agent auf deinem Computer. Beantworte ein paar kurze Fragen, dann passe ich mich deiner Arbeitsweise an.', 'Sou o agente que vive no seu computador. Responda a algumas perguntas rápidas e eu me adapto ao seu jeito de trabalhar.', 'あなたのコンピューターで動くエージェントです。いくつかの質問に答えると、あなたの作業スタイルに合わせて設定します。', '我是运行在你电脑上的智能体。回答几个简单的问题，我就能按你的工作习惯完成设置。'),
  welcomeTime: text('About a minute. Every step is skippable, and you can change everything later.', 'Aproximadamente un minuto. Puedes omitir cualquier paso y cambiar todo más tarde.', 'Environ une minute. Vous pouvez ignorer chaque étape et tout modifier plus tard.', 'Dauert etwa eine Minute. Du kannst jeden Schritt überspringen und alles später ändern.', 'Leva cerca de um minuto. Você pode pular qualquer etapa e mudar tudo depois.', '約1分で終わります。どの手順もスキップでき、設定は後から変更できます。', '大约需要一分钟。每一步都可以跳过，之后也可以修改所有设置。'),
  name: text('What should I call you?', '¿Cómo quieres que te llame?', 'Comment dois-je vous appeler ?', 'Wie soll ich dich nennen?', 'Como devo chamar você?', 'お名前を教えてください', '我该怎么称呼你？'),
  nameHint: text('Your name, a nickname, anything you like.', 'Tu nombre, un apodo, lo que prefieras.', 'Votre prénom, un surnom, comme vous préférez.', 'Dein Name, ein Spitzname oder was dir gefällt.', 'Seu nome, um apelido, o que preferir.', '本名でもニックネームでも、お好きな呼び方で。', '名字、昵称，怎么称呼你都可以。'),
  namePlaceholder: text('Your name', 'Tu nombre', 'Votre nom', 'Dein Name', 'Seu nome', 'お名前', '你的名字'),
  greeting: text('Hi there, what should we work on?', 'Hola, ¿en qué trabajamos hoy?', 'Bonjour, sur quoi travaillons-nous ?', 'Hallo, woran wollen wir arbeiten?', 'Olá, em que vamos trabalhar?', 'こんにちは。今日は何をしましょうか？', '你好，今天我们做点什么？'),
  greetingNamed: text('Hi {name}, what should we work on?', 'Hola, {name}, ¿en qué trabajamos hoy?', 'Bonjour {name}, sur quoi travaillons-nous ?', 'Hallo {name}, woran wollen wir arbeiten?', 'Olá, {name}, em que vamos trabalhar?', '{name}さん、今日は何をしましょうか？', '{name}，你好！今天我们做点什么？'),
  email: text("What's your email?", '¿Cuál es tu correo electrónico?', 'Quelle est votre adresse e-mail ?', 'Wie lautet deine E-Mail-Adresse?', 'Qual é o seu e-mail?', 'メールアドレスを教えてください', '你的电子邮件地址是什么？'),
  emailNamed: text("What's your email, {name}?", '{name}, ¿cuál es tu correo electrónico?', 'Quelle est votre adresse e-mail, {name} ?', 'Wie lautet deine E-Mail-Adresse, {name}?', 'Qual é o seu e-mail, {name}?', '{name}さん、メールアドレスを教えてください', '{name}，你的电子邮件地址是什么？'),
  emailHint: text("Optional. Only if you'd like to hear about big updates.", 'Opcional. Solo si quieres recibir noticias sobre actualizaciones importantes.', 'Facultatif, si vous souhaitez être informé des mises à jour importantes.', 'Freiwillig. Nur wenn du von wichtigen Updates erfahren möchtest.', 'Opcional. Só se quiser receber notícias sobre grandes atualizações.', '任意です。重要な更新のお知らせを受け取りたい場合のみ入力してください。', '可选。仅在你想接收重要更新时填写。'),
  invalidEmail: text("That doesn't look like an email yet.", 'Introduce una dirección de correo válida.', 'Saisissez une adresse e-mail valide.', 'Das sieht noch nicht wie eine E-Mail-Adresse aus.', 'Esse endereço de e-mail parece incompleto.', '有効なメールアドレスを入力してください。', '请输入有效的电子邮件地址。'),
  emailPromise: text('We never sell, share or spam.', 'No vendemos ni compartimos tu correo. Tampoco enviamos spam.', 'Nous ne vendons ni ne partageons votre adresse et n’envoyons aucun spam.', 'Wir verkaufen und teilen deine Adresse nicht und versenden keinen Spam.', 'Não vendemos nem compartilhamos seu e-mail e não enviamos spam.', 'アドレスの販売・共有や迷惑メールの送信は行いません。', '我们不会出售或共享你的地址，也不会发送垃圾邮件。'),
  emailPolicy: text("At most one email a month about new features and important fixes. We'll send one email to confirm, and you can unsubscribe in one click.", 'Como máximo un correo al mes sobre nuevas funciones y correcciones importantes. Te enviaremos un correo de confirmación y podrás cancelar la suscripción con un clic.', 'Au plus un e-mail par mois sur les nouveautés et correctifs importants. Nous vous enverrons un e-mail de confirmation, et vous pourrez vous désabonner en un clic.', 'Höchstens eine E-Mail im Monat zu neuen Funktionen und wichtigen Korrekturen. Du erhältst eine Bestätigungs-E-Mail und kannst dich mit einem Klick abmelden.', 'No máximo um e-mail por mês sobre novidades e correções importantes. Enviaremos um e-mail de confirmação e você pode cancelar a inscrição com um clique.', '新機能や重要な修正のお知らせは月に最大1通です。確認メールを1通お送りし、ワンクリックで配信を停止できます。', '每月最多发送一封关于新功能和重要修复的邮件。我们会发送一封确认邮件，你也可以一键退订。'),
  privacy: text('Privacy policy', 'Política de privacidad', 'Politique de confidentialité', 'Datenschutzrichtlinie', 'Política de privacidade', 'プライバシーポリシー', '隐私政策'),
  emailSavedLocally: text("Saved your email here, but it didn't reach Nekko Cloud: {error}", 'Guardamos tu correo aquí, pero no llegó a Nekko Cloud: {error}', 'Votre adresse a été enregistrée ici, mais Nekko Cloud ne l’a pas reçue : {error}', 'Deine E-Mail-Adresse wurde hier gespeichert, hat Nekko Cloud aber nicht erreicht: {error}', 'Seu e-mail foi salvo aqui, mas não chegou ao Nekko Cloud: {error}', 'メールアドレスはこの端末に保存されましたが、Nekko Cloud に届きませんでした：{error}', '电子邮件地址已保存在此设备，但未能发送到 Nekko Cloud：{error}'),
  work: text('What do you mostly do?', '¿A qué te dedicas principalmente?', 'Quelle est votre activité principale ?', 'Was machst du hauptsächlich?', 'O que você mais faz?', '普段はどんな作業をしますか？', '你平时主要做什么？'),
  workNamed: text('What do you mostly do, {name}?', '{name}, ¿a qué te dedicas principalmente?', '{name}, quelle est votre activité principale ?', '{name}, was machst du hauptsächlich?', '{name}, o que você mais faz?', '{name}さん、普段はどんな作業をしますか？', '{name}，你平时主要做什么？'),
  workHint: text('Pick the closest. It only sets where I start, and you can change anything later.', 'Elige lo más parecido. Solo es un punto de partida: podrás cambiarlo todo después.', 'Choisissez l’option la plus proche. C’est un point de départ : tout peut être modifié plus tard.', 'Wähle, was am besten passt. Das ist nur der Ausgangspunkt, alles lässt sich später ändern.', 'Escolha a opção mais próxima. É só um ponto de partida e você pode mudar tudo depois.', '最も近いものを選んでください。初期設定にのみ使われ、後から変更できます。', '选择最接近的一项。这只影响初始设置，之后都能修改。'),
  developer: text('Developer', 'Desarrollo', 'Développement', 'Entwicklung', 'Desenvolvimento', '開発', '开发'),
  designer: text('Designer', 'Diseño', 'Design', 'Design', 'Design', 'デザイン', '设计'),
  writer: text('Writer or researcher', 'Escritura o investigación', 'Rédaction ou recherche', 'Schreiben oder Forschen', 'Escrita ou pesquisa', '執筆・調査', '写作或研究'),
  business: text('Product or business', 'Producto o negocios', 'Produit ou commerce', 'Produkt oder Geschäft', 'Produto ou negócios', 'プロダクト・ビジネス', '产品或商务'),
  student: text('Student', 'Estudios', 'Études', 'Studium', 'Estudos', '学業', '学习'),
  exploring: text('Just exploring', 'Solo explorando', 'Simple curiosité', 'Nur umschauen', 'Só explorando', 'まずは試してみる', '随便看看'),
  developerDesc: text('Code, terminals, pull requests', 'Código, terminales, pull requests', 'Code, terminaux, pull requests', 'Code, Terminals, Pull Requests', 'Código, terminais, pull requests', 'コード、ターミナル、プルリクエスト', '代码、终端、拉取请求'),
  designerDesc: text('Interfaces, prototypes, assets', 'Interfaces, prototipos, recursos', 'Interfaces, prototypes, ressources', 'Oberflächen, Prototypen, Assets', 'Interfaces, protótipos, recursos', 'UI、プロトタイプ、素材', '界面、原型、素材'),
  writerDesc: text('Drafts, sources, summaries', 'Borradores, fuentes, resúmenes', 'Brouillons, sources, résumés', 'Entwürfe, Quellen, Zusammenfassungen', 'Rascunhos, fontes, resumos', '下書き、資料、要約', '草稿、来源、摘要'),
  businessDesc: text('Plans, docs, spreadsheets', 'Planes, documentos, hojas de cálculo', 'Plans, documents, feuilles de calcul', 'Pläne, Dokumente, Tabellen', 'Planos, documentos, planilhas', '計画、文書、表計算', '计划、文档、电子表格'),
  studentDesc: text('Learning, notes, projects', 'Aprendizaje, notas, proyectos', 'Apprentissage, notes, projets', 'Lernen, Notizen, Projekte', 'Aprendizado, anotações, projetos', '学習、ノート、課題', '学习、笔记、项目'),
  exploringDesc: text('Show me what you can do', 'Muéstrame qué puedes hacer', 'Montrez-moi ce que vous savez faire', 'Zeig mir, was du kannst', 'Mostre o que você pode fazer', 'できることを見てみたい', '看看你能做什么'),
  minimal: text('Minimal', 'Mínimo', 'Minimal', 'Minimal', 'Mínimo', '最小限', '极简'),
  regular: text('Regular', 'Normal', 'Standard', 'Normal', 'Padrão', '標準', '标准'),
  detailed: text('Detailed', 'Detallado', 'Détaillé', 'Detailliert', 'Detalhado', '詳細', '详细'),
  starts: text('Starts {level}', 'Empieza en modo {level}', 'Mode initial : {level}', 'Startet mit {level}', 'Começa no modo {level}', '初期設定：{level}', '初始模式：{level}'),
  startsMonitors: text('Starts {level} · Monitors on', 'Empieza en modo {level} · Monitores activos', 'Mode initial : {level} · Moniteurs affichés', 'Startet mit {level} · Monitore an', 'Começa no modo {level} · Monitores ativos', '初期設定：{level}（モニター表示）', '初始模式：{level} · 显示监视面板'),
  detail: text('How much detail do you like?', '¿Cuánto detalle prefieres?', 'Quel niveau de détail préférez-vous ?', 'Wie ausführlich soll es sein?', 'Quanto detalhe você quer ver?', 'どのくらい詳しく表示しますか？', '你希望显示多少细节？'),
  detailHint: text('Same answer, three ways. Try each one.', 'La misma respuesta en tres versiones. Pruébalas todas.', 'Une même réponse, trois présentations. Essayez-les.', 'Dieselbe Antwort in drei Varianten. Probiere sie aus.', 'A mesma resposta de três formas. Experimente todas.', '同じ回答を3通りで表示します。それぞれお試しください。', '同一回答有三种显示方式。试试每一种。'),
  look: text('Make it yours', 'Dale tu estilo', 'À votre image', 'Mach es zu deinem', 'Deixe do seu jeito', '好みの外観に', '自定义外观'),
  providers: text('Connect a model', 'Conecta un modelo', 'Connecter un modèle', 'Ein Modell verbinden', 'Conecte um modelo', 'モデルを接続', '连接模型'),
  dictation: text('Set up local dictation', 'Configura el dictado local', 'Configurer la dictée locale', 'Lokales Diktat einrichten', 'Configure o ditado local', 'ローカル音声入力を設定', '设置本地语音输入'),
  integrations: text('Meet your tools', 'Conoce tus herramientas', 'Découvrez vos outils', 'Deine Werkzeuge kennenlernen', 'Conheça suas ferramentas', 'ツールとの連携', '认识你的工具'),
  tracking: text('Track the work', 'Haz seguimiento del trabajo', 'Suivre le travail', 'Arbeit verfolgen', 'Acompanhe o trabalho', '作業を追跡する', '跟踪工作'),
  help: text('Help improve Nekko Agent?', '¿Quieres ayudar a mejorar Nekko Agent?', 'Envie d’aider à améliorer Nekko Agent ?', 'Nekko Agent verbessern helfen?', 'Quer ajudar a melhorar o Nekko Agent?', 'Nekko Agent の改善に協力しますか？', '愿意帮助改进 Nekko Agent 吗？'),
  doneNamed: text('Nice to meet you, {name}!', '¡Mucho gusto, {name}!', 'Ravi de vous rencontrer, {name} !', 'Schön, dich kennenzulernen, {name}!', 'Prazer, {name}!', '{name}さん、よろしくお願いします！', '很高兴认识你，{name}！'),
  done: text("You're set", 'Todo listo', 'Tout est prêt', 'Alles bereit', 'Tudo pronto', '設定が完了しました', '设置完成'),
  doneHint: text('Here are three things to try first. Pick one to jump right in, or hit Finish.', 'Aquí tienes tres ideas para empezar. Elige una o pulsa Finalizar.', 'Voici trois idées pour commencer. Choisissez-en une, ou cliquez sur Terminer.', 'Hier sind drei Ideen für den Anfang. Wähle eine aus oder klicke auf Fertig.', 'Aqui vão três ideias para começar. Escolha uma ou clique em Concluir.', 'まず試せることを3つ紹介します。どれかを選ぶか、「完了」を押してください。', '你可以先试试下面三件事。任选一项开始，或者点击“完成”。'),
  doneChat: text('Start your first chat', 'Inicia tu primer chat', 'Lancer votre première conversation', 'Deinen ersten Chat starten', 'Inicie seu primeiro chat', '最初のチャットを始める', '开始第一次对话'),
  doneChatHint: text('Open a new agent session in the Agent tab.', 'Abre una sesión nueva en la pestaña Agentes.', 'Ouvrez une session dans l’onglet Agents.', 'Öffne eine neue Sitzung im Tab „Agenten“.', 'Abra uma sessão nova na aba Agentes.', '「エージェント」タブで新しいセッションを開きます。', '在“智能体”选项卡中打开一个新会话。'),
  doneProvider: text('Connect a model provider', 'Conecta un proveedor de modelos', 'Connecter un fournisseur de modèles', 'Einen Modellanbieter verbinden', 'Conecte um provedor de modelos', 'モデルプロバイダーを接続', '连接模型提供商'),
  doneProviderHint: text('Bring a subscription, an API key, or a local server in Models.', 'Añade una suscripción, una clave de API o un servidor local en Modelos.', 'Ajoutez un abonnement, une clé d’API ou un serveur local dans Modèles.', 'Hinterlege ein Abo, einen API-Schlüssel oder einen lokalen Server unter Modelle.', 'Adicione uma assinatura, uma chave de API ou um servidor local em Modelos.', '「モデル」でサブスクリプション、API キー、ローカルサーバーのいずれかを追加します。', '在“模型”中添加订阅、API 密钥或本地服务器。'),
  doneApps: text('Wire up your apps', 'Vincula tus aplicaciones', 'Connecter vos applications', 'Deine Apps verknüpfen', 'Vincule seus aplicativos', 'アプリを連携', '连接你的应用'),
  doneAppsHint: text('Link GitHub, Slack, and more in Connectors.', 'Vincula GitHub, Slack y más en Conectores.', 'Associez GitHub, Slack et d’autres services dans Connecteurs.', 'Verknüpfe GitHub, Slack und mehr unter Konnektoren.', 'Vincule GitHub, Slack e outros serviços em Conectores.', '「コネクター」で GitHub や Slack などを連携します。', '在“连接器”中关联 GitHub、Slack 等服务。'),
} as const;

export type OnboardingKey = keyof typeof onboardingMessages;
export function onboardingText(lang: Language, key: OnboardingKey, vars: Record<string, string | number> = {}) {
  return onboardingMessages[key][lang].replace(/\{(\w+)\}/g, (placeholder, name: string) => String(vars[name] ?? placeholder));
}

export function useOnboardingT() {
  const lang = useLanguage();
  return useCallback((key: OnboardingKey, vars?: Record<string, string | number>) => onboardingText(lang, key, vars), [lang]);
}
