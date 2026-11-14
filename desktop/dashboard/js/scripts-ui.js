// Formulario de parámetros de las suites de scripts (TikTok, Spotify, Twitch).
//
// Los scripts documentados en tikmatrix.com/docs/tutorial-scripts tienen entre 1 y
// 20 opciones cada uno. Encadenar customPrompt() para eso es inusable, así que aquí
// hay un modal que se construye solo a partir del esquema de cada script, igual que
// el diálogo "Start Script" de la app original.

const TIKTOK_SCRIPTS = {
    TIKTOK_LOGIN: {
        titulo: 'Login',
        descripcion: 'Entra con email+contraseña y, si no hay email, con usuario+contraseña. Para si detecta cuenta suspendida.',
        campos: [
            { k: 'email', t: 'text', label: 'Email', placeholder: 'prioritario sobre el usuario' },
            { k: 'username', t: 'text', label: 'Usuario (respaldo)', placeholder: '@usuario' },
            { k: 'password', t: 'text', label: 'Contraseña', placeholder: 'contraseña o contraseña:secreto_2fa' },
        ],
    },
    TIKTOK_SWITCH_ACCOUNT: {
        titulo: 'Switch Account',
        descripcion: 'Cambia a otra cuenta ya presente en el teléfono. Sin usuario, salta a la siguiente de la lista.',
        campos: [{ k: 'username', t: 'text', label: 'Usuario destino (opcional)', placeholder: '@usuario' }],
    },
    TIKTOK_PUBLISH_POST: {
        titulo: 'Post',
        descripcion: 'Publica desde la galería con pie de foto. Limpia la galería antes: se toma el primer elemento.',
        campos: [
            { k: 'method', t: 'select', label: 'Método', opciones: [['plus', 'Botón + '], ['sound', 'Usar sonido por búsqueda']], def: 'plus' },
            { k: 'sound_name', t: 'text', label: 'Sonido (método por sonido)', placeholder: 'nombre o URL' },
            { k: 'captions', t: 'lista', label: 'Pies de foto', placeholder: 'uno por línea; admite spintax {a|b}' },
            { k: 'caption_order', t: 'select', label: 'Orden', opciones: [['random', 'Aleatorio'], ['sequential', 'Secuencial']], def: 'random' },
            { k: 'upload_wait_sec', t: 'num', label: 'Espera de subida (s)', def: 15 },
            { k: 'save_draft', t: 'bool', label: 'Guardar solo como borrador' },
            { k: 'insert_emoji', t: 'bool', label: 'Insertar emoji' },
        ],
    },
    TIKTOK_FOLLOW_BACK: {
        titulo: 'Follow Back',
        descripcion: 'Devuelve el seguimiento a los seguidores que aún no sigues. Ignora los que ya salen como "Siguiendo".',
        campos: [{ k: 'max_follow', t: 'num', label: 'Máximo a seguir', def: 20 }],
    },
    TIKTOK_UNFOLLOW_ALL: {
        titulo: 'Unfollow All',
        descripcion: 'Recorre la lista de seguidos dejando de seguir, con confirmación cuando aparece.',
        campos: [{ k: 'limit', t: 'num', label: 'Máximo a dejar de seguir', def: 20 }],
    },
    TIKTOK_TEST_SCRIPT: {
        titulo: 'Test Script',
        descripcion: 'Comprobación sin efectos: app instalada, uiautomator, resolución e idioma. Úsalo antes de un script largo.',
        campos: [],
    },
    TIKTOK_ACCOUNT_WARMUP: {
        titulo: 'Account Warmup',
        descripcion: 'Navega el feed viendo, dando like, siguiendo, comentando y guardando, con probabilidades configurables.',
        campos: [
            { k: 'browse_mode', t: 'select', label: 'Modo de navegación', opciones: [['foryou', 'Para ti'], ['following', 'Siguiendo'], ['search', 'Buscar vídeos']], def: 'foryou' },
            { k: 'keywords', t: 'lista', label: 'Palabras clave (solo modo buscar)', placeholder: 'una por línea' },
            { k: 'view_min_sec', t: 'num', label: 'Ver desde (s)', def: 5 },
            { k: 'view_max_sec', t: 'num', label: 'Ver hasta (s)', def: 15 },
            { k: 'duration_min', t: 'num', label: 'Duración total (min)', def: 10 },
            { k: 'p_like', t: 'num', label: 'Probabilidad de like (0-1)', def: 0.3, step: 0.05 },
            { k: 'p_follow', t: 'num', label: 'Probabilidad de seguir (0-1)', def: 0.05, step: 0.05 },
            { k: 'p_comment', t: 'num', label: 'Probabilidad de comentar (0-1)', def: 0.05, step: 0.05 },
            { k: 'p_favorite', t: 'num', label: 'Probabilidad de guardar (0-1)', def: 0.05, step: 0.05 },
            { k: 'comments', t: 'lista', label: 'Comentarios candidatos', placeholder: 'uno por línea; admite spintax {a|b}' },
            { k: 'comment_order', t: 'select', label: 'Orden de comentarios', opciones: [['random', 'Aleatorio'], ['sequential', 'Secuencial']], def: 'random' },
            { k: 'insert_emoji', t: 'bool', label: 'Insertar emoji' },
        ],
    },
    TIKTOK_FILL_PROFILE: {
        titulo: 'Fill Profile',
        descripcion: 'Aplica apodo, nombre de usuario, biografía y avatar. Limpia la galería antes: se toma la primera foto.',
        campos: [
            { k: 'nicknames', t: 'lista', label: 'Apodos', placeholder: 'uno por línea' },
            { k: 'usernames', t: 'lista', label: 'Nombres de usuario', placeholder: 'uno por línea' },
            { k: 'bios', t: 'lista', label: 'Biografías', placeholder: 'una por línea' },
            { k: 'selection_order', t: 'select', label: 'Orden de selección', opciones: [['random', 'Aleatorio'], ['sequential', 'Secuencial']], def: 'random' },
            { k: 'set_avatar', t: 'bool', label: 'Poner avatar desde la galería' },
        ],
    },
    TIKTOK_MATCH_ACCOUNTS: {
        titulo: 'Match Account',
        descripcion: 'Lee las cuentas presentes en el dispositivo. Puede requerir varias pasadas.',
        campos: [],
    },
    TIKTOK_SCRAPE_USERS: {
        titulo: 'Scrape Users',
        descripcion: 'Recolecta usuarios por seguidores, seguidos o búsqueda. TikTok limita a ~50 por pasada.',
        campos: [
            { k: 'mode', t: 'select', label: 'Modo', opciones: [['followers', 'Por seguidores'], ['following', 'Por seguidos'], ['keyword', 'Por palabra clave']], def: 'followers' },
            { k: 'targets', t: 'lista', label: 'Cuentas objetivo', placeholder: 'una por línea (modos seguidores/seguidos)' },
            { k: 'keywords', t: 'lista', label: 'Palabras clave', placeholder: 'modo palabra clave' },
            { k: 'max_count', t: 'num', label: 'Máximo a extraer', def: 50 },
        ],
    },
    TIKTOK_FOLLOW_SUGGESTED: {
        titulo: 'Follow Suggested',
        descripcion: 'Sigue cuentas de la pestaña "Sugeridas" hasta el límite o hasta agotar sugerencias.',
        campos: [{ k: 'max_follow', t: 'num', label: 'Máximo a seguir', def: 20 }],
    },
    TIKTOK_MASS_DM: {
        titulo: 'Mass DM',
        descripcion: 'Envía DM a una lista de usuarios. Admite {username} y {sender_username}, y spintax {a|b}.',
        campos: [
            { k: 'targets', t: 'lista', label: 'Usuarios destino', placeholder: 'uno por línea' },
            { k: 'messages', t: 'lista', label: 'Mensajes', placeholder: 'uno por línea' },
            { k: 'messages_per_target', t: 'num', label: 'Mensajes por destino', def: 1 },
            { k: 'message_order', t: 'select', label: 'Orden', opciones: [['random', 'Aleatorio'], ['sequential', 'Secuencial']], def: 'random' },
            { k: 'open_method', t: 'select', label: 'Abrir perfil', opciones: [['direct', 'Directo'], ['search', 'Buscando']], def: 'direct' },
            { k: 'sender_username', t: 'text', label: 'Tu usuario (para {sender_username})' },
            { k: 'interval_min_sec', t: 'num', label: 'Intervalo mínimo (s)', def: 20 },
            { k: 'interval_max_sec', t: 'num', label: 'Intervalo máximo (s)', def: 60 },
            { k: 'insert_emoji', t: 'bool', label: 'Insertar emoji' },
        ],
    },
    TIKTOK_MASS_COMMENT: {
        titulo: 'Mass Comment',
        descripcion: 'Comenta una lista de publicaciones por URL.',
        campos: [
            { k: 'urls', t: 'lista', label: 'URLs de publicaciones', placeholder: 'una por línea' },
            { k: 'comments', t: 'lista', label: 'Comentarios', placeholder: 'uno por línea' },
            { k: 'comments_per_target', t: 'num', label: 'Comentarios por publicación', def: 1 },
            { k: 'comment_order', t: 'select', label: 'Orden', opciones: [['random', 'Aleatorio'], ['sequential', 'Secuencial']], def: 'random' },
            { k: 'device_label', t: 'text', label: 'Etiqueta de dispositivo (opcional)' },
            { k: 'interval_min_sec', t: 'num', label: 'Intervalo mínimo (s)', def: 20 },
            { k: 'interval_max_sec', t: 'num', label: 'Intervalo máximo (s)', def: 60 },
            { k: 'insert_emoji', t: 'bool', label: 'Insertar emoji' },
        ],
    },
    TIKTOK_BOOST_POSTS: {
        titulo: 'Boost Posts',
        descripcion: 'Interactúa con una lista de publicaciones: ver, like, guardar, repost, compartir y comentar.',
        campos: [
            { k: 'urls', t: 'lista', label: 'URLs de publicaciones', placeholder: 'una por línea' },
            { k: 'repeat', t: 'num', label: 'Repeticiones', def: 1 },
            { k: 'view_min_sec', t: 'num', label: 'Ver desde (s)', def: 5 },
            { k: 'view_max_sec', t: 'num', label: 'Ver hasta (s)', def: 20 },
            { k: 'like', t: 'bool', label: 'Dar like', def: true },
            { k: 'favorite', t: 'bool', label: 'Guardar' },
            { k: 'repost', t: 'bool', label: 'Repost' },
            { k: 'share', t: 'bool', label: 'Compartir' },
            { k: 'comment', t: 'bool', label: 'Comentar' },
            { k: 'comments', t: 'lista', label: 'Comentarios', placeholder: 'uno por línea' },
        ],
    },
    TIKTOK_BOOST_LIVES: {
        titulo: 'Boost Lives',
        descripcion: 'Entra a los directos indicados, ve, da likes por intervalo y comenta.',
        campos: [
            { k: 'usernames', t: 'lista', label: 'Streamers', placeholder: 'uno por línea' },
            { k: 'enter_method', t: 'select', label: 'Entrar', opciones: [['direct', 'Directo'], ['search', 'Buscando']], def: 'direct' },
            { k: 'view_duration_sec', t: 'num', label: 'Ver (s)', def: 120 },
            { k: 'like_interval_sec', t: 'num', label: 'Intervalo de likes (s)', def: 15 },
            { k: 'like_tap_count', t: 'num', label: 'Toques por tanda', def: 5 },
            { k: 'comment_interval_sec', t: 'num', label: 'Intervalo de comentarios (s)', def: 45 },
            { k: 'comments_per_account', t: 'num', label: 'Comentarios por cuenta', def: 3 },
            { k: 'comments', t: 'lista', label: 'Comentarios', placeholder: 'uno por línea' },
            { k: 'join_fan_club', t: 'bool', label: 'Unirse al club de fans' },
            { k: 'check_in_daily', t: 'bool', label: 'Registro diario' },
        ],
    },
    TIKTOK_BOOST_COMMENTS: {
        titulo: 'Boost Comments',
        descripcion: 'Da like y responde a comentarios concretos por URL.',
        campos: [
            { k: 'urls', t: 'lista', label: 'URLs de comentarios', placeholder: 'una por línea' },
            { k: 'like', t: 'bool', label: 'Dar like al comentario', def: true },
            { k: 'reply', t: 'bool', label: 'Responder' },
            { k: 'replies', t: 'lista', label: 'Respuestas', placeholder: 'una por línea' },
            { k: 'reply_order', t: 'select', label: 'Orden', opciones: [['random', 'Aleatorio'], ['sequential', 'Secuencial']], def: 'random' },
            { k: 'interval_sec', t: 'num', label: 'Intervalo (s)', def: 20 },
            { k: 'insert_emoji', t: 'bool', label: 'Insertar emoji' },
        ],
    },
    TIKTOK_DELETE_POSTS: {
        titulo: 'Delete Post',
        descripcion: 'Borra publicaciones por debajo de un umbral de vistas. Irreversible.',
        peligro: true,
        campos: [
            { k: 'max_views', t: 'num', label: 'Vistas máximas (umbral)', def: 100 },
            { k: 'max_posts', t: 'num', label: 'Máximo a procesar (0 = todas)', def: 0 },
        ],
    },
    TIKTOK_PRIVACY_SETTINGS: {
        titulo: 'Privacy Settings',
        descripcion: 'Cambia quién puede ver las publicaciones por debajo de un umbral de vistas. No se puede deshacer desde el script.',
        peligro: true,
        campos: [
            { k: 'max_views', t: 'num', label: 'Vistas máximas (umbral)', def: 100 },
            { k: 'max_posts', t: 'num', label: 'Máximo a procesar (0 = todas)', def: 0 },
            { k: 'who_can_watch', t: 'select', label: 'Quién puede verlo', opciones: [['friends', 'Amigos'], ['only_me', 'Solo yo'], ['everyone', 'Todos']], def: 'friends' },
            { k: 'allow_comments', t: 'bool', label: 'Permitir comentarios', def: true },
            { k: 'allow_reuse', t: 'bool', label: 'Permitir reutilizar', def: true },
        ],
    },
    TIKTOK_SUPER_MARKETING: {
        titulo: 'Super Marketing',
        descripcion: 'Cola única: seguir/dejar de seguir, DM, interacción con publicaciones y comentarios sobre cada objetivo.',
        campos: [
            { k: 'data_source', t: 'select', label: 'Origen de datos', opciones: [['usernames', 'Lista de usuarios'], ['urls', 'Lista de URLs']], def: 'usernames' },
            { k: 'targets', t: 'lista', label: 'Objetivos', placeholder: 'uno por línea' },
            { k: 'consumption_limit', t: 'num', label: 'Límite por tarea (0 = sin límite)', def: 0 },
            { k: 'follow', t: 'bool', label: 'Seguir' },
            { k: 'unfollow', t: 'bool', label: 'Dejar de seguir' },
            { k: 'send_dm', t: 'bool', label: 'Enviar DM' },
            { k: 'messages', t: 'lista', label: 'Mensajes DM', placeholder: 'uno por línea' },
            { k: 'sender_username', t: 'text', label: 'Tu usuario (para {sender_username})' },
            { k: 'skip_posts', t: 'num', label: 'Saltar publicaciones (0-8)', def: 0 },
            { k: 'max_posts', t: 'num', label: 'Publicaciones a procesar (1-50)', def: 3 },
            { k: 'view_min_sec', t: 'num', label: 'Ver desde (s)', def: 3 },
            { k: 'view_max_sec', t: 'num', label: 'Ver hasta (s)', def: 20 },
            { k: 'like', t: 'bool', label: 'Like' },
            { k: 'favorite', t: 'bool', label: 'Guardar' },
            { k: 'repost', t: 'bool', label: 'Repost' },
            { k: 'share', t: 'bool', label: 'Compartir' },
            { k: 'comment', t: 'bool', label: 'Comentar' },
            { k: 'comments', t: 'lista', label: 'Comentarios', placeholder: 'uno por línea' },
            { k: 'template_order', t: 'select', label: 'Orden de plantillas', opciones: [['random', 'Aleatorio'], ['sequential', 'Secuencial']], def: 'random' },
            { k: 'interval_min_min', t: 'num', label: 'Intervalo mínimo (min)', def: 0 },
            { k: 'interval_max_min', t: 'num', label: 'Intervalo máximo (min)', def: 0 },
            { k: 'insert_emoji', t: 'bool', label: 'Insertar emoji' },
        ],
    },
    TIKTOK_LIST_PACKAGES: {
        titulo: 'App Packages',
        descripcion: 'Comprueba qué apps objetivo hay en el dispositivo, incluidos clones por prefijo.',
        campos: [
            { k: 'tiktok', t: 'bool', label: 'TikTok Global (com.zhiliaoapp.musically)', def: true },
            { k: 'tiktok_asia', t: 'bool', label: 'TikTok Asia (com.ss.android.ugc.trill)' },
            { k: 'instagram', t: 'bool', label: 'Instagram', def: true },
            { k: 'clone_prefix', t: 'text', label: 'Prefijo de clones', placeholder: 'ej. com.miclon.' },
        ],
    },

    // ---------------------------------------------------------------- SPOTIFY
    SPOTIFY_LOGIN: {
        titulo: 'Login', app: 'spotify',
        descripcion: 'Entra con correo o usuario y contraseña.',
        campos: [
            { k: 'email', t: 'text', label: 'Correo o usuario' },
            { k: 'password', t: 'text', label: 'Contraseña' },
        ],
    },
    SPOTIFY_MATCH_ACCOUNT: {
        titulo: 'Match Account', app: 'spotify',
        descripcion: 'Lee la cuenta con la que está iniciada la sesión.',
        campos: [],
    },
    SPOTIFY_PLAY_URL: {
        titulo: 'Play URL', app: 'spotify',
        descripcion: 'Abre un enlace de Spotify y lo reproduce. Acepta URL, URI spotify: o el id de 22 caracteres.',
        campos: [
            { k: 'url', t: 'text', label: 'Enlace o id', placeholder: 'https://open.spotify.com/track/…' },
            { k: 'tipo', t: 'select', label: 'Tipo (para ids sueltos)', opciones: [['track', 'Canción'], ['album', 'Álbum'], ['playlist', 'Playlist'], ['artist', 'Artista']], def: 'track' },
            { k: 'play_seconds', t: 'num', label: 'Segundos de reproducción', def: 45 },
            { k: 'shuffle', t: 'bool', label: 'Reproducción aleatoria' },
            { k: 'pause_after', t: 'bool', label: 'Pausar al terminar' },
        ],
    },
    SPOTIFY_SEARCH_PLAY: {
        titulo: 'Search & Play', app: 'spotify',
        descripcion: 'Busca y reproduce el primer resultado.',
        campos: [
            { k: 'query', t: 'text', label: 'Búsqueda', placeholder: 'artista, canción…' },
            { k: 'play_seconds', t: 'num', label: 'Segundos de reproducción', def: 45 },
            { k: 'solo_canciones', t: 'bool', label: 'Filtrar solo canciones', def: true },
        ],
    },
    SPOTIFY_STREAM_CAMPAIGN: {
        titulo: 'Stream Campaign', app: 'spotify',
        descripcion: 'Recorre una lista de enlaces reproduciendo cada uno, con duración y huecos aleatorios.',
        peligro: true,
        campos: [
            { k: 'urls', t: 'lista', label: 'Enlaces', placeholder: 'uno por línea' },
            { k: 'repeat', t: 'num', label: 'Pasadas', def: 1 },
            { k: 'play_min_sec', t: 'num', label: 'Reproducir desde (s)', def: 35 },
            { k: 'play_max_sec', t: 'num', label: 'Reproducir hasta (s)', def: 70 },
            { k: 'gap_min_sec', t: 'num', label: 'Hueco mínimo (s)', def: 3 },
            { k: 'gap_max_sec', t: 'num', label: 'Hueco máximo (s)', def: 12 },
            { k: 'order', t: 'select', label: 'Orden', opciones: [['sequential', 'Secuencial'], ['random', 'Aleatorio']], def: 'sequential' },
            { k: 'save_track', t: 'bool', label: 'Guardar en Tus me gusta' },
        ],
    },
    SPOTIFY_WARMUP: {
        titulo: 'Warmup', app: 'spotify',
        descripcion: 'Escucha desde la portada entrando en elementos al azar, con probabilidad de guardar, seguir o saltar.',
        campos: [
            { k: 'duration_min', t: 'num', label: 'Duración total (min)', def: 10 },
            { k: 'play_min_sec', t: 'num', label: 'Escuchar desde (s)', def: 30 },
            { k: 'play_max_sec', t: 'num', label: 'Escuchar hasta (s)', def: 90 },
            { k: 'p_save', t: 'num', label: 'Probabilidad de guardar (0-1)', def: 0.10, step: 0.05 },
            { k: 'p_follow', t: 'num', label: 'Probabilidad de seguir (0-1)', def: 0.05, step: 0.05 },
            { k: 'p_skip', t: 'num', label: 'Probabilidad de saltar (0-1)', def: 0.20, step: 0.05 },
        ],
    },
    SPOTIFY_FOLLOW_ARTIST: {
        titulo: 'Follow Artist', app: 'spotify',
        descripcion: 'Sigue artistas por nombre o por enlace. Los que ya sigues se dejan intactos.',
        campos: [{ k: 'artists', t: 'lista', label: 'Artistas', placeholder: 'nombre o enlace, uno por línea' }],
    },
    SPOTIFY_SAVE_TRACK: {
        titulo: 'Save Track', app: 'spotify',
        descripcion: 'Guarda en Tus me gusta la pista indicada, o la que esté sonando si no pones enlace.',
        campos: [{ k: 'url', t: 'text', label: 'Enlace de la pista (opcional)' }],
    },
    SPOTIFY_CREATE_PLAYLIST: {
        titulo: 'Create Playlist', app: 'spotify',
        descripcion: 'Crea una playlist nueva. Admite spintax en el nombre.',
        campos: [{ k: 'name', t: 'text', label: 'Nombre', placeholder: 'Mi {mix|lista} {2026|nueva}' }],
    },
    SPOTIFY_ADD_TO_PLAYLIST: {
        titulo: 'Add to Playlist', app: 'spotify',
        descripcion: 'Agrega una pista a una playlist existente.',
        campos: [
            { k: 'playlist', t: 'text', label: 'Playlist destino' },
            { k: 'url', t: 'text', label: 'Enlace de la pista (opcional)' },
        ],
    },
    SPOTIFY_PLAYBACK: {
        titulo: 'Playback', app: 'spotify',
        descripcion: 'Controles de reproducción sobre lo que esté sonando.',
        campos: [
            { k: 'action', t: 'select', label: 'Acción', opciones: [['play', 'Reproducir'], ['pause', 'Pausar'], ['next', 'Siguiente'], ['previous', 'Anterior'], ['shuffle', 'Aleatorio'], ['repeat', 'Repetir'], ['save', 'Me gusta']], def: 'play' },
            { k: 'times', t: 'num', label: 'Veces', def: 1 },
        ],
    },
    SPOTIFY_TEST_SCRIPT: {
        titulo: 'Test Script', app: 'spotify',
        descripcion: 'Comprueba sin efectos: app instalada, lectura de pantalla, sesión y pista en curso.',
        campos: [],
    },

    // ------------------------------------------------------------- YT MUSIC
    YTMUSIC_CREATE_PLAYLIST: {
        titulo: 'Crear playlist exacta · YT Music', app: 'ytmusic', peligro: true,
        descripcion: 'Crea una playlist en el perfil activo usando pares exactos de artista y canción. Si una búsqueda falta o es ambigua, se detiene en vez de elegir el primer resultado.',
        campos: [
            { k: 'playlist_name', t: 'text', label: 'Nombre de la playlist', placeholder: 'Mi selección' },
            { k: 'privacy', t: 'select', label: 'Privacidad', opciones: [['private', 'Privada'], ['unlisted', 'No listada'], ['public', 'Pública']], def: 'private' },
            { k: 'tracks', t: 'track_pairs', label: 'Canciones (en orden)' },
        ],
    },

    // ----------------------------------------------------------------- TWITCH
    TWITCH_LOGIN: {
        titulo: 'Login', app: 'twitch',
        descripcion: 'Entra con usuario y contraseña.',
        campos: [
            { k: 'username', t: 'text', label: 'Usuario o correo' },
            { k: 'password', t: 'text', label: 'Contraseña' },
        ],
    },
    TWITCH_MATCH_ACCOUNT: {
        titulo: 'Match Account', app: 'twitch',
        descripcion: 'Lee la cuenta con la que está iniciada la sesión.',
        campos: [],
    },
    TWITCH_WATCH_STREAM: {
        titulo: 'Watch Stream', app: 'twitch',
        descripcion: 'Abre un canal y lo ve el tiempo indicado, tocando de vez en cuando para no quedar inactivo.',
        campos: [
            { k: 'channel', t: 'text', label: 'Canal', placeholder: 'nombre o URL' },
            { k: 'watch_seconds', t: 'num', label: 'Segundos de visionado', def: 120 },
            { k: 'unmute', t: 'bool', label: 'Activar sonido' },
            { k: 'follow', t: 'bool', label: 'Seguir el canal' },
        ],
    },
    TWITCH_WATCH_CAMPAIGN: {
        titulo: 'Watch Campaign', app: 'twitch',
        descripcion: 'Recorre una lista de canales viendo cada uno. Los que no estén emitiendo se saltan.',
        peligro: true,
        campos: [
            { k: 'channels', t: 'lista', label: 'Canales', placeholder: 'uno por línea' },
            { k: 'repeat', t: 'num', label: 'Pasadas', def: 1 },
            { k: 'watch_min_sec', t: 'num', label: 'Ver desde (s)', def: 90 },
            { k: 'watch_max_sec', t: 'num', label: 'Ver hasta (s)', def: 240 },
            { k: 'gap_min_sec', t: 'num', label: 'Hueco mínimo (s)', def: 5 },
            { k: 'gap_max_sec', t: 'num', label: 'Hueco máximo (s)', def: 20 },
            { k: 'order', t: 'select', label: 'Orden', opciones: [['sequential', 'Secuencial'], ['random', 'Aleatorio']], def: 'sequential' },
            { k: 'follow', t: 'bool', label: 'Seguir cada canal' },
        ],
    },
    TWITCH_WARMUP: {
        titulo: 'Warmup', app: 'twitch',
        descripcion: 'Recorre el feed de descubrimiento viendo streams, con probabilidad de seguir.',
        campos: [
            { k: 'duration_min', t: 'num', label: 'Duración total (min)', def: 10 },
            { k: 'watch_min_sec', t: 'num', label: 'Ver desde (s)', def: 30 },
            { k: 'watch_max_sec', t: 'num', label: 'Ver hasta (s)', def: 120 },
            { k: 'p_follow', t: 'num', label: 'Probabilidad de seguir (0-1)', def: 0.08, step: 0.02 },
        ],
    },
    TWITCH_FOLLOW_CHANNEL: {
        titulo: 'Follow Channel', app: 'twitch',
        descripcion: 'Sigue una lista de canales. Los que ya sigues se dejan intactos.',
        campos: [{ k: 'channels', t: 'lista', label: 'Canales', placeholder: 'uno por línea' }],
    },
    TWITCH_UNFOLLOW_CHANNEL: {
        titulo: 'Unfollow Channel', app: 'twitch',
        descripcion: 'Deja de seguir una lista de canales.',
        campos: [{ k: 'channels', t: 'lista', label: 'Canales', placeholder: 'uno por línea' }],
    },
    TWITCH_CHAT_MESSAGE: {
        titulo: 'Chat Message', app: 'twitch',
        descripcion: 'Escribe en el chat de un canal. Admite spintax y varias plantillas.',
        peligro: true,
        campos: [
            { k: 'channel', t: 'text', label: 'Canal' },
            { k: 'messages', t: 'lista', label: 'Mensajes', placeholder: 'uno por línea; admite {a|b}' },
            { k: 'count', t: 'num', label: 'Cuántos enviar', def: 1 },
            { k: 'order', t: 'select', label: 'Orden', opciones: [['random', 'Aleatorio'], ['sequential', 'Secuencial']], def: 'random' },
            { k: 'gap_min_sec', t: 'num', label: 'Hueco mínimo (s)', def: 20 },
            { k: 'gap_max_sec', t: 'num', label: 'Hueco máximo (s)', def: 60 },
            { k: 'insert_emoji', t: 'bool', label: 'Insertar emoji' },
        ],
    },
    TWITCH_PLAYBACK: {
        titulo: 'Playback', app: 'twitch',
        descripcion: 'Controles sobre el reproductor.',
        campos: [
            { k: 'action', t: 'select', label: 'Acción', opciones: [['unmute', 'Activar sonido'], ['mute', 'Silenciar'], ['share', 'Compartir'], ['menu', 'Menú']], def: 'unmute' },
        ],
    },
    TWITCH_TEST_SCRIPT: {
        titulo: 'Test Script', app: 'twitch',
        descripcion: 'Comprueba sin efectos: app instalada, lectura de pantalla, sesión y si hay directo.',
        campos: [],
    },
};

// Bloque que TikMatrix repite en el diálogo de TODOS sus scripts y que sus
// páginas de documentación no recogen: rotación de proxy, cierre de la app al
// terminar, selección de paquete con prefijo de clones e intervalo de tarea.
const COMUNES_BASE = [
    { k: 'rotate_proxy', t: 'bool', label: 'Rotar proxy antes de la tarea' },
    { k: 'close_app_after', t: 'bool', label: 'Cerrar la app al terminar', def: true },
    { k: 'task_interval_min', t: 'num', label: 'Intervalo de tarea, mínimo (min)', def: 0 },
    { k: 'task_interval_max', t: 'num', label: 'Intervalo de tarea, máximo (min)', def: 0 },
];

// La selección de paquete con clones es propia de TikTok: Spotify y Twitch no
// tienen variantes regionales ni se clonan para multicuenta en esta granja.
const COMUNES_PAQUETE_TIKTOK = [
    { k: 'pkg_tiktok', t: 'bool', label: 'TikTok Global (com.zhiliaoapp.musically)', def: true },
    { k: 'pkg_tiktok_asia', t: 'bool', label: 'TikTok Asia (com.ss.android.ugc.trill)' },
    { k: 'pkg_instagram', t: 'bool', label: 'Instagram (com.instagram.android)' },
    { k: 'clone_prefix', t: 'text', label: 'Prefijo de apps clonadas', placeholder: 'ej. com.tiktok.clone.' },
];

function comunesDe(comando) {
    const def = TIKTOK_SCRIPTS[comando] || {};
    const app = def.app || 'tiktok';
    return app === 'tiktok' ? [...COMUNES_PAQUETE_TIKTOK, ...COMUNES_BASE] : [...COMUNES_BASE];
}

// Avisos que la app original muestra en scripts concretos.
const AVISOS = {
    TIKTOK_MATCH_ACCOUNTS: 'Antes de emparejar cuentas, inicia sesión en TikTok en el teléfono. El sistema reconoce las cuentas ya conectadas para el cambio entre cuentas.',
    TIKTOK_LOGIN: 'TikTok no automatiza el login por completo: puede pedir verificación manual. El script se detiene si detecta cuenta suspendida.',
    TIKTOK_FILL_PROFILE: 'Limpia la galería antes de ejecutarlo: se toma la primera foto como avatar.',
    TIKTOK_SCRAPE_USERS: 'TikTok limita la lista visible: se recuperan unos 50 registros por pasada.',
};

let scriptActual = null;

function renderCampos(campos) {
    return campos.map(c => {
        const id = `tmf_${c.k}`;
        if (c.t === 'bool') {
            return `<label class="tm-campo tm-check"><input type="checkbox" id="${id}" ${c.def ? 'checked' : ''}> <span>${c.label}</span></label>`;
        }
        if (c.t === 'select') {
            const ops = c.opciones.map(([v, n]) => `<option value="${v}" ${v === c.def ? 'selected' : ''}>${n}</option>`).join('');
            return `<label class="tm-campo"><span>${c.label}</span><select id="${id}" class="modal-input">${ops}</select></label>`;
        }
        if (c.t === 'lista') {
            return `<label class="tm-campo"><span>${c.label}</span><textarea id="${id}" class="modal-input" rows="3" placeholder="${c.placeholder || ''}"></textarea></label>`;
        }
        if (c.t === 'track_pairs') {
            return `<div class="tm-campo tm-ancho"><span>${c.label}</span>
              <div id="${id}" class="tm-track-list">
                <div class="tm-track-row">
                  <input class="modal-input tm-track-artist" placeholder="Artista exacto">
                  <input class="modal-input tm-track-title" placeholder="Canción exacta">
                  <input class="modal-input tm-track-url" placeholder="URL music.youtube.com (opcional)">
                  <button type="button" class="btn-secondary" onclick="removeYtMusicTrackRow(this)" title="Quitar canción">×</button>
                </div>
              </div>
              <button type="button" class="btn-secondary" style="margin-top:7px" onclick="addYtMusicTrackRow('${id}')">+ Agregar canción</button>
            </div>`;
        }
        const tipo = c.t === 'num' ? 'number' : 'text';
        const step = c.step ? ` step="${c.step}"` : '';
        return `<label class="tm-campo"><span>${c.label}</span><input type="${tipo}"${step} id="${id}" class="modal-input" value="${c.def ?? ''}" placeholder="${c.placeholder || ''}"></label>`;
    }).join('');
}

function abrirScript(comando) {
    const def = TIKTOK_SCRIPTS[comando];
    if (!def) return;
    scriptActual = comando;

    const propios = renderCampos(def.campos);
    // List Packages ES el selector de paquete, así que no se le añade encima.
    const comunes = comando === 'TIKTOK_LIST_PACKAGES' ? '' : renderCampos(comunesDe(comando));
    const seleccionados = selectedDeviceIds.size || devices.filter(d => ['online', 'busy'].includes(d.status)).length;

    document.getElementById('tmScriptTitle').textContent = def.titulo;
    document.getElementById('tmScriptDesc').textContent = def.descripcion;
    document.getElementById('tmScriptFields').innerHTML =
        (propios || '<p class="muted-text tm-ancho">Este script no tiene parámetros propios.</p>') +
        (comunes ? `<div class="tm-grupo">Opciones comunes</div>${comunes}` : '');
    document.getElementById('tmScriptTargets').textContent =
        `Se ejecutará en ${seleccionados} dispositivo(s)${selectedDeviceIds.size ? ' seleccionados' : ' en línea'}.`;

    const nota = document.getElementById('tmScriptNote');
    nota.textContent = AVISOS[comando] || '';
    nota.hidden = !AVISOS[comando];

    const aviso = document.getElementById('tmScriptWarn');
    aviso.hidden = !def.peligro;
    document.getElementById('tmScriptModal').hidden = false;
}

function cerrarScript() {
    document.getElementById('tmScriptModal').hidden = true;
    scriptActual = null;
}

function lanzarScript() {
    const comando = scriptActual;
    const def = TIKTOK_SCRIPTS[comando];
    if (!def) return;

    const campos = comando === 'TIKTOK_LIST_PACKAGES' ? def.campos : [...def.campos, ...comunesDe(comando)];
    const params = {};
    for (const c of campos) {
        const el = document.getElementById(`tmf_${c.k}`);
        if (!el) continue;
        if (c.t === 'bool') { params[c.k] = el.checked; continue; }
        const v = el.value;
        if (c.t === 'num') {
            const n = parseFloat(v);
            // Sin este filtro, un campo vacío mandaba NaN y el script lo tomaba
            // como 0 (duración cero, cero repeticiones…).
            if (Number.isFinite(n)) params[c.k] = n;
            continue;
        }
        if (c.t === 'lista') {
            const lista = v.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
            if (lista.length) params[c.k] = lista;
            continue;
        }
        if (c.t === 'track_pairs') {
            const tracks = [...el.querySelectorAll('.tm-track-row')].map(row => ({
                artist: row.querySelector('.tm-track-artist')?.value.trim() || '',
                title: row.querySelector('.tm-track-title')?.value.trim() || '',
                url: row.querySelector('.tm-track-url')?.value.trim() || '',
            })).filter(track => track.artist || track.title || track.url);
            if (tracks.length) params[c.k] = tracks;
            continue;
        }
        if (v && v.trim()) params[c.k] = v.trim();
    }

    if (comando === 'YTMUSIC_CREATE_PLAYLIST' || comando === 'YTMUSIC_CREATE_PLAYLIST_FROM_TRACKS') {
        params.idempotency_key = ytmId('ytm-playlist');
    }

    cerrarScript();
    quickAction(comando, params);
}

// Stop Task no es un comando del teléfono: cancela en el servidor lo que haya en
// cola o corriendo y luego cierra la app en cada dispositivo, para que un script
// interrumpido no deje el móvil a medias en una pantalla cualquiera.
async function detenerTareas(paqueteObjetivo) {
    let ids = [...selectedDeviceIds];
    if (!ids.length) ids = devices.filter(d => ['online', 'busy'].includes(d.status)).map(d => d.id);
    if (!ids.length) { alert('No hay dispositivos a los que parar tareas.'); return; }

    // Cada pestaña pasa su propia app: parar tareas cierra la que estaba en uso.
    const paquete = paqueteObjetivo || 'com.zhiliaoapp.musically';
    try {
        const r = await apiFetch('/tasks/stop', {
            method: 'POST',
            body: JSON.stringify({ device_ids: ids, package_name: paquete }),
        });
        addLog(r.message || 'Tareas detenidas', 'warning');
        loadAll();
    } catch (e) {
        addLog(`Error al detener tareas: ${e.message}`, 'error');
    }
}

window.abrirScript = abrirScript;
window.cerrarScript = cerrarScript;
window.lanzarScript = lanzarScript;
window.detenerTareas = detenerTareas;

function addYtMusicTrackRow(containerId = 'tmf_tracks') {
    const container = document.getElementById(containerId);
    if (!container || container.querySelectorAll('.tm-track-row').length >= 50) return;
    const row = document.createElement('div');
    row.className = 'tm-track-row';
    row.innerHTML = `<input class="modal-input tm-track-artist" placeholder="Artista exacto">
      <input class="modal-input tm-track-title" placeholder="Canción exacta">
      <input class="modal-input tm-track-url" placeholder="URL music.youtube.com (opcional)">
      <button type="button" class="btn-secondary" onclick="removeYtMusicTrackRow(this)" title="Quitar canción">×</button>`;
    container.appendChild(row);
}

function removeYtMusicTrackRow(button) {
    const container = button?.closest('.tm-track-list');
    const rows = container ? container.querySelectorAll('.tm-track-row') : [];
    if (rows.length > 1) button.closest('.tm-track-row')?.remove();
    else rows[0]?.querySelectorAll('input').forEach(input => { input.value = ''; });
}

function selectedYtMusicDeviceIds() {
    const selected = [...selectedDeviceIds];
    if (selected.length) return selected;
    return devices.filter(device => ['online', 'busy'].includes(device.status)).map(device => device.id);
}

function ytmId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function refreshYtMusicGuard() {
    const target = document.getElementById('ytMusicGuardStatus');
    if (!target) return;
    try {
        const response = await apiFetch('/youtube-music/guard');
        const state = response.data || {};
        const status = state.running ? 'COMPROBANDO' : state.enabled ? 'ACTIVO' : 'APAGADO';
        const handled = Number(state.last_result?.handled || 0);
        target.textContent = `${status} · ${state.device_ids?.length || 0} dispositivo(s) · lote ${state.batch_size || 5} · última intervención del ciclo: ${handled}` +
            (state.last_error ? ` · ${state.last_error}` : '');
        if (!state.enabled) {
            document.getElementById('ytMusicGuardPoll').value = state.poll_interval_seconds || 30;
            document.getElementById('ytMusicGuardCooldown').value = state.cooldown_seconds || 90;
            document.getElementById('ytMusicGuardBatch').value = state.batch_size || 5;
        }
    } catch (error) {
        target.textContent = `No disponible: ${error.message}`;
    }
}

async function configureYtMusicGuard() {
    const ids = selectedYtMusicDeviceIds();
    if (!ids.length) { alert('Seleccione al menos un dispositivo online.'); return; }
    if (!confirm(`Guardar el monitor de YT Music para ${ids.length} dispositivo(s) seleccionados?`)) return;
    try {
        await apiFetch('/youtube-music/guard/config', {
            method: 'PUT',
            body: JSON.stringify({
                device_ids: ids,
                poll_interval_seconds: Number(document.getElementById('ytMusicGuardPoll').value),
                cooldown_seconds: Number(document.getElementById('ytMusicGuardCooldown').value),
                batch_size: Number(document.getElementById('ytMusicGuardBatch').value),
                confirm: true,
                idempotency_key: ytmId('ytm-guard-config'),
            }),
        });
        addLog(`Monitor YT Music configurado para ${ids.length} dispositivo(s)`, 'info');
        await refreshYtMusicGuard();
    } catch (error) { addLog(`YT Music monitor: ${error.message}`, 'error'); alert(error.message); }
}

async function startYtMusicGuard() {
    if (!confirm('Activar el monitor de inactividad de YT Music con la configuración guardada?')) return;
    try {
        await apiFetch('/youtube-music/guard/start', {
            method: 'POST',
            body: JSON.stringify({ confirm: true, run_immediately: true, idempotency_key: ytmId('ytm-guard-start') }),
        });
        addLog('Monitor YT Music activado', 'info');
        await refreshYtMusicGuard();
    } catch (error) { addLog(`YT Music monitor: ${error.message}`, 'error'); alert(error.message); }
}

async function stopYtMusicGuard() {
    try {
        await apiFetch('/youtube-music/guard/stop', {
            method: 'POST',
            body: JSON.stringify({ confirm: true, reason: 'operator stop', idempotency_key: ytmId('ytm-guard-stop') }),
        });
        addLog('Monitor YT Music detenido', 'warning');
        await refreshYtMusicGuard();
    } catch (error) { addLog(`YT Music monitor: ${error.message}`, 'error'); alert(error.message); }
}

async function checkYtMusicGuardNow() {
    try {
        await apiFetch('/youtube-music/guard/check-now', {
            method: 'POST',
            body: JSON.stringify({ confirm: true, idempotency_key: ytmId('ytm-guard-check') }),
        });
        addLog('Comprobación YT Music solicitada', 'info');
        setTimeout(refreshYtMusicGuard, 1200);
    } catch (error) { addLog(`YT Music monitor: ${error.message}`, 'error'); alert(error.message); }
}

function escapeYtReview(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
}

let ytMusicReviewCandidatesById = new Map();
function renderYtMusicReviewQueue(candidates = []) {
    const target = document.getElementById('ytMusicReviewQueue');
    if (!target) return;
    ytMusicReviewCandidatesById = new Map(candidates.map(candidate => [Number(candidate.id), candidate]));
    if (!candidates.length) {
        target.innerHTML = '<div class="yt-review-card">No hay candidatos en la cola.</div>';
        return;
    }
    target.innerHTML = candidates.map(candidate => {
        const pending = candidate.status === 'pending_review';
        const type = candidate.candidate_type === 'comment' ? 'Comentario' : 'Like';
        const track = [candidate.track_artist, candidate.track_title].filter(Boolean).join(' · ');
        const draft = candidate.comment_draft
            ? `<div><strong>Borrador:</strong> ${escapeYtReview(candidate.comment_draft)}</div>`
            : '';
        const candidateId = Number(candidate.id);
        const actions = pending ? `<div class="yt-review-card-actions">
          ${candidate.candidate_type === 'comment' ? `<button class="btn-secondary" data-yt-review-action="edit" data-candidate-id="${candidateId}">✏️ Editar borrador</button>` : ''}
          <button class="btn-secondary" data-yt-review-action="approve" data-candidate-id="${candidateId}">✅ Aprobar para acción manual</button>
          <button class="btn-secondary" data-yt-review-action="dismiss" data-candidate-id="${candidateId}">🗑️ Descartar</button>
        </div>` : '';
        return `<div class="yt-review-card">
          <div><strong>#${candidate.id} · ${type}</strong> · ${escapeYtReview(candidate.device_name || candidate.device_id)}</div>
          <div>${escapeYtReview(track || 'Pista sin etiqueta')}</div>
          ${draft}
          <div style="color:#94a3b8">${escapeYtReview(candidate.status)} · ${escapeYtReview(candidate.generated_at)}</div>
          ${actions}
        </div>`;
    }).join('');
    target.querySelectorAll('[data-yt-review-action]').forEach(button => {
        button.addEventListener('click', () => {
            const candidateId = Number(button.dataset.candidateId);
            if (!Number.isInteger(candidateId) || !ytMusicReviewCandidatesById.has(candidateId)) return;
            const action = button.dataset.ytReviewAction;
            if (action === 'edit') editYtMusicReviewDraft(candidateId);
            if (action === 'approve') approveYtMusicReviewCandidate(candidateId);
            if (action === 'dismiss') dismissYtMusicReviewCandidate(candidateId);
        });
    });
}

let ytMusicReviewConfigHydrated = false;
async function refreshYtMusicReviewQueue() {
    const status = document.getElementById('ytMusicReviewStatus');
    if (!status) return;
    try {
        const response = await apiFetch('/youtube-music/review-queue?limit=100');
        const config = response.data?.config || {};
        const candidates = response.data?.candidates || [];
        if (!ytMusicReviewConfigHydrated) {
            document.getElementById('ytReviewLikeProbability').value = config.like_candidate_probability ?? 0.15;
            document.getElementById('ytReviewCommentProbability').value = config.comment_candidate_probability ?? 0.05;
            document.getElementById('ytReviewCooldown').value = config.cooldown_seconds ?? 1800;
            document.getElementById('ytReviewDrafts').value = (config.comment_drafts || []).join('\n');
            ytMusicReviewConfigHydrated = true;
        }
        const counts = config.counts || {};
        status.textContent = `SOLO REVISIÓN MANUAL · pendientes ${counts.pending_review || 0} · aprobados ${counts.approved_manual || 0} · descartados ${counts.dismissed || 0} · 0 comandos enviados`;
        renderYtMusicReviewQueue(candidates);
    } catch (error) {
        status.textContent = `Cola no disponible: ${error.message}`;
    }
}

async function configureYtMusicReviewQueue() {
    const ids = selectedYtMusicDeviceIds();
    if (!ids.length) { alert('Seleccione al menos un dispositivo en línea.'); return; }
    const drafts = document.getElementById('ytReviewDrafts').value
        .split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if (!confirm(`Guardar la configuración de candidatos para ${ids.length} dispositivo(s)? Esto no enviará acciones a los teléfonos.`)) return;
    try {
        await apiFetch('/youtube-music/review-queue/config', {
            method: 'PUT',
            body: JSON.stringify({
                device_ids: ids,
                like_candidate_probability: Number(document.getElementById('ytReviewLikeProbability').value),
                comment_candidate_probability: Number(document.getElementById('ytReviewCommentProbability').value),
                cooldown_seconds: Number(document.getElementById('ytReviewCooldown').value),
                comment_drafts: drafts,
                confirm: true,
                idempotency_key: ytmId('ytm-review-config'),
            }),
        });
        addLog('Cola segura de revisión YT Music configurada', 'info');
        await refreshYtMusicReviewQueue();
    } catch (error) { addLog(`Cola YT Music: ${error.message}`, 'error'); alert(error.message); }
}

async function generateYtMusicReviewCandidates() {
    const ids = selectedYtMusicDeviceIds();
    const artist = document.getElementById('ytReviewTrackArtist').value.trim();
    const title = document.getElementById('ytReviewTrackTitle').value.trim();
    if (!ids.length) { alert('Seleccione al menos un dispositivo en línea.'); return; }
    if (!artist && !title) { alert('Indique el artista o la canción observada.'); return; }
    if (!confirm(`Evaluar la pista para ${ids.length} dispositivo(s)? Solo se crearán candidatos de revisión; no habrá likes ni comentarios automáticos.`)) return;
    try {
        const seed = ytmId('ytm-observation');
        const results = await Promise.all(ids.map(deviceId => apiFetch('/youtube-music/review-queue/observe', {
            method: 'POST',
            body: JSON.stringify({
                device_id: deviceId,
                track_artist: artist,
                track_title: title,
                observation_key: `${seed}-device-${deviceId}`,
                source: 'dashboard-operator-observation',
            }),
        })));
        const queued = results.reduce((count, result) => count + Number(result.data?.candidates?.length || 0), 0);
        addLog(`YT Music: ${queued} candidato(s) añadidos; ninguna acción enviada`, 'info');
        await refreshYtMusicReviewQueue();
    } catch (error) { addLog(`Cola YT Music: ${error.message}`, 'error'); alert(error.message); }
}

async function editYtMusicReviewDraft(candidateId) {
    const current = ytMusicReviewCandidatesById.get(Number(candidateId))?.comment_draft || '';
    const draft = await customPrompt('Editar borrador', 'Este texto queda en la cola y no se publica automáticamente.', current, 'Máximo 280 caracteres');
    if (draft == null) return;
    try {
        await apiFetch(`/youtube-music/review-queue/${candidateId}/draft`, {
            method: 'PATCH',
            body: JSON.stringify({ comment_draft: draft, confirm: true, idempotency_key: ytmId('ytm-review-edit') }),
        });
        await refreshYtMusicReviewQueue();
    } catch (error) { alert(error.message); }
}

async function approveYtMusicReviewCandidate(candidateId) {
    if (!confirm('Aprobar esta sugerencia para una acción MANUAL? No se enviará ningún comando al teléfono.')) return;
    try {
        await apiFetch(`/youtube-music/review-queue/${candidateId}/approve`, {
            method: 'POST',
            body: JSON.stringify({ confirm: true, actor: 'dashboard-operator', idempotency_key: ytmId('ytm-review-approve') }),
        });
        addLog(`Candidato #${candidateId} aprobado para revisión manual; 0 comandos enviados`, 'info');
        await refreshYtMusicReviewQueue();
    } catch (error) { alert(error.message); }
}

async function dismissYtMusicReviewCandidate(candidateId) {
    if (!confirm('Descartar este candidato?')) return;
    try {
        await apiFetch(`/youtube-music/review-queue/${candidateId}/dismiss`, {
            method: 'POST',
            body: JSON.stringify({ confirm: true, actor: 'dashboard-operator', idempotency_key: ytmId('ytm-review-dismiss') }),
        });
        await refreshYtMusicReviewQueue();
    } catch (error) { alert(error.message); }
}

async function exportYtMusicApproved() {
    try {
        const response = await apiFetch('/youtube-music/review-queue-export?limit=200');
        const blob = new Blob([JSON.stringify(response.data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `ytmusic-manual-review-${Date.now()}.json`;
        anchor.click();
        URL.revokeObjectURL(url);
    } catch (error) { alert(error.message); }
}

window.addYtMusicTrackRow = addYtMusicTrackRow;
window.removeYtMusicTrackRow = removeYtMusicTrackRow;
window.refreshYtMusicGuard = refreshYtMusicGuard;
window.configureYtMusicGuard = configureYtMusicGuard;
window.startYtMusicGuard = startYtMusicGuard;
window.stopYtMusicGuard = stopYtMusicGuard;
window.checkYtMusicGuardNow = checkYtMusicGuardNow;
window.refreshYtMusicReviewQueue = refreshYtMusicReviewQueue;
window.configureYtMusicReviewQueue = configureYtMusicReviewQueue;
window.generateYtMusicReviewCandidates = generateYtMusicReviewCandidates;
window.editYtMusicReviewDraft = editYtMusicReviewDraft;
window.approveYtMusicReviewCandidate = approveYtMusicReviewCandidate;
window.dismissYtMusicReviewCandidate = dismissYtMusicReviewCandidate;
window.exportYtMusicApproved = exportYtMusicApproved;
setTimeout(refreshYtMusicGuard, 700);
setTimeout(refreshYtMusicReviewQueue, 900);
setInterval(refreshYtMusicGuard, 10000);
setInterval(refreshYtMusicReviewQueue, 15000);
