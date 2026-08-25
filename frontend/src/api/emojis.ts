// Standard Emoji Data - Organized by Category
// Complete list of emojis available on Windows/macOS/iOS/Android

import type { IconName } from '../components/Icons';

export interface EmojiCategory {
    name: string;
    // Tab glyph for the picker's category rail — an icon-set name, not an emoji.
    icon: IconName;
    emojis: string[];
}

export const EMOJI_CATEGORIES: EmojiCategory[] = [
    {
        name: 'Frequently Used',
        icon: 'clock',
        emojis: ['👍', '❤️', '😂', '🎉', '🔥', '👀', '💯', '✅', '😊', '🙏', '👏', '😍'],
    },
    {
        name: 'Smileys & Emotion',
        icon: 'smile',
        emojis: [
            // Happy faces
            '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '😊', '😇', '🥰',
            '😍', '🤩', '😘', '😗', '☺️', '😚', '😙', '🥲', '😋', '😛', '😜', '🤪',
            '😝', '🤑', '🤗', '🤭', '🫢', '🤫', '🤔', '🫡',
            // Neutral faces
            '🤐', '🤨', '😐', '😑', '😶', '🫥', '😏', '😒', '🙄', '😬', '🫠', '😮‍💨', '🤥',
            // Sleepy/unwell faces
            '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮', '🤧', '🥵',
            '🥶', '🥴', '😵', '😵‍💫', '🤯',
            // Hat faces
            '🤠', '🥳', '🥸', '😎', '🤓', '🧐',
            // Concerned faces
            '😕', '🫤', '😟', '🙁', '☹️', '😮', '😯', '😲', '😳', '🥺', '🥹', '😦',
            '😧', '😨', '😰', '😥', '😢', '😭', '😱', '😖', '😣', '😞', '😓', '😩',
            '😫', '🥱',
            // Angry faces
            '😤', '😡', '😠', '🤬', '😈', '👿',
            // Costume faces
            '💀', '☠️', '💩', '🤡', '👹', '👺', '👻', '👽', '👾', '🤖',
            // Cat faces
            '😺', '😸', '😹', '😻', '😼', '😽', '🙀', '😿', '😾',
            // Monkey faces
            '🙈', '🙉', '🙊',
            // Hearts
            '💌', '💘', '💝', '💖', '💗', '💓', '💞', '💕', '💟', '❣️', '💔', '❤️‍🔥',
            '❤️‍🩹', '❤️', '🩷', '🧡', '💛', '💚', '💙', '🩵', '💜', '🤎', '🖤', '🩶', '🤍',
            // Emotion symbols
            '💋', '💯', '💢', '💥', '💫', '💦', '💨', '🕳️', '💬', '👁️‍🗨️', '🗨️', '🗯️', '💭', '💤',
        ],
    },
    {
        name: 'People & Body',
        icon: 'members',
        emojis: [
            // Hand gestures
            '👋', '🤚', '🖐️', '✋', '🖖', '🫱', '🫲', '🫳', '🫴', '🫷', '🫸',
            '👌', '🤌', '🤏', '✌️', '🤞', '🫰', '🤟', '🤘', '🤙',
            '👈', '👉', '👆', '🖕', '👇', '☝️', '🫵',
            '👍', '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '🫶', '👐', '🤲', '🤝', '🙏',
            // Hand parts
            '✍️', '💅', '🤳', '💪', '🦾', '🦿', '🦵', '🦶',
            // Body parts
            '👂', '🦻', '👃', '🧠', '🫀', '🫁', '🦷', '🦴', '👀', '👁️', '👅', '👄', '🫦',
            // People
            '👶', '🧒', '👦', '👧', '🧑', '👱', '👨', '🧔', '🧔‍♂️', '🧔‍♀️', '👩', '🧓', '👴', '👵',
            // Person gestures
            '🙍', '🙍‍♂️', '🙍‍♀️', '🙎', '🙎‍♂️', '🙎‍♀️', '🙅', '🙅‍♂️', '🙅‍♀️', '🙆', '🙆‍♂️', '🙆‍♀️',
            '💁', '💁‍♂️', '💁‍♀️', '🙋', '🙋‍♂️', '🙋‍♀️', '🧏', '🧏‍♂️', '🧏‍♀️', '🙇', '🙇‍♂️', '🙇‍♀️',
            '🤦', '🤦‍♂️', '🤦‍♀️', '🤷', '🤷‍♂️', '🤷‍♀️',
            // Professions
            '👮', '👮‍♂️', '👮‍♀️', '🕵️', '🕵️‍♂️', '🕵️‍♀️', '💂', '💂‍♂️', '💂‍♀️', '🥷',
            '👷', '👷‍♂️', '👷‍♀️', '🫅', '🤴', '👸', '👳', '👳‍♂️', '👳‍♀️', '👲',
            '🧕', '🤵', '🤵‍♂️', '🤵‍♀️', '👰', '👰‍♂️', '👰‍♀️', '🤰', '🫃', '🫄',
            '🤱', '👼', '🎅', '🤶', '🧑‍🎄', '🦸', '🦸‍♂️', '🦸‍♀️', '🦹', '🦹‍♂️', '🦹‍♀️',
            '🧙', '🧙‍♂️', '🧙‍♀️', '🧚', '🧚‍♂️', '🧚‍♀️', '🧛', '🧛‍♂️', '🧛‍♀️', '🧜', '🧜‍♂️', '🧜‍♀️',
            '🧝', '🧝‍♂️', '🧝‍♀️', '🧞', '🧞‍♂️', '🧞‍♀️', '🧟', '🧟‍♂️', '🧟‍♀️', '🧌',
            // Activities
            '💆', '💆‍♂️', '💆‍♀️', '💇', '💇‍♂️', '💇‍♀️', '🚶', '🚶‍♂️', '🚶‍♀️', '🧍', '🧍‍♂️', '🧍‍♀️',
            '🧎', '🧎‍♂️', '🧎‍♀️', '🏃', '🏃‍♂️', '🏃‍♀️', '💃', '🕺', '🕴️',
            // Couples
            '👯', '👯‍♂️', '👯‍♀️', '🧖', '🧖‍♂️', '🧖‍♀️', '🧗', '🧗‍♂️', '🧗‍♀️',
            '👫', '👭', '👬', '💏', '💑', '👪',
            // Families
            '👨‍👩‍👦', '👨‍👩‍👧', '👨‍👩‍👧‍👦', '👨‍👩‍👦‍👦', '👨‍👩‍👧‍👧',
            '👨‍👦', '👨‍👦‍👦', '👨‍👧', '👨‍👧‍👦', '👨‍👧‍👧',
            '👩‍👦', '👩‍👦‍👦', '👩‍👧', '👩‍👧‍👦', '👩‍👧‍👧',
            // Symbols
            '🗣️', '👤', '👥', '🫂', '👣',
        ],
    },
    {
        name: 'Animals & Nature',
        icon: 'leaf',
        emojis: [
            // Mammals
            '🐶', '🐕', '🦮', '🐕‍🦺', '🐩', '🐺', '🦊', '🦝', '🐱', '🐈', '🐈‍⬛', '🦁',
            '🐯', '🐅', '🐆', '🐴', '🫎', '🫏', '🐎', '🦄', '🦓', '🦌', '🦬', '🐮', '🐂',
            '🐃', '🐄', '🐷', '🐖', '🐗', '🐽', '🐏', '🐑', '🐐', '🐪', '🐫', '🦙', '🦒',
            '🐘', '🦣', '🦏', '🦛', '🐭', '🐁', '🐀', '🐹', '🐰', '🐇', '🐿️', '🦫', '🦔',
            '🦇', '🐻', '🐻‍❄️', '🐨', '🐼', '🦥', '🦦', '🦨', '🦘', '🦡',
            // Birds
            '🐔', '🐓', '🐣', '🐤', '🐥', '🐦', '🐦‍⬛', '🐧', '🕊️', '🦅', '🦆', '🦢', '🦉',
            '🦤', '🪶', '🦩', '🦚', '🦜', '🪽', '🐦‍🔥', '🪿',
            // Marine
            '🐸', '🐊', '🐢', '🦎', '🐍', '🐲', '🐉', '🦕', '🦖',
            '🐳', '🐋', '🐬', '🦭', '🐟', '🐠', '🐡', '🦈', '🐙', '🐚', '🪸', '🪼', '🦀', '🦞',
            '🦐', '🦑', '🦪',
            // Bugs
            '🐌', '🦋', '🐛', '🐜', '🐝', '🪲', '🐞', '🦗', '🪳', '🕷️', '🕸️', '🦂', '🦟',
            '🪰', '🪱', '🦠',
            // Plants
            '💐', '🌸', '💮', '🪷', '🏵️', '🌹', '🥀', '🌺', '🌻', '🌼', '🌷', '🪻', '🌱',
            '🪴', '🌲', '🌳', '🌴', '🌵', '🌾', '🌿', '☘️', '🍀', '🍁', '🍂', '🍃', '🪹', '🪺',
            '🍇', '🍄', '🍄‍🟫',
        ],
    },
    {
        name: 'Food & Drink',
        icon: 'food',
        emojis: [
            // Fruits
            '🍇', '🍈', '🍉', '🍊', '🍋', '🍋‍🟩', '🍌', '🍍', '🥭', '🍎', '🍏', '🍐', '🍑',
            '🍒', '🍓', '🫐', '🥝', '🍅', '🫒', '🥥',
            // Vegetables
            '🥑', '🍆', '🥔', '🥕', '🌽', '🌶️', '🫑', '🥒', '🥬', '🥦', '🧄', '🧅', '🍄',
            '🥜', '🫘', '🌰',
            // Prepared foods
            '🍞', '🥐', '🥖', '🫓', '🥨', '🥯', '🥞', '🧇', '🧀', '🍖', '🍗', '🥩', '🥓',
            '🍔', '🍟', '🍕', '🌭', '🥪', '🌮', '🌯', '🫔', '🥙', '🧆', '🥚', '🍳', '🥘',
            '🍲', '🫕', '🥣', '🥗', '🍿', '🧈', '🧂', '🥫',
            // Asian food
            '🍱', '🍘', '🍙', '🍚', '🍛', '🍜', '🍝', '🍠', '🍢', '🍣', '🍤', '🍥', '🥮',
            '🍡', '🥟', '🥠', '🥡',
            // Desserts
            '🍦', '🍧', '🍨', '🍩', '🍪', '🎂', '🍰', '🧁', '🥧', '🍫', '🍬', '🍭', '🍮', '🍯',
            // Drinks
            '🍼', '🥛', '☕', '🫖', '🍵', '🍶', '🍾', '🍷', '🍸', '🍹', '🍺', '🍻', '🥂',
            '🥃', '🫗', '🥤', '🧋', '🧃', '🧉', '🧊',
            // Utensils
            '🥢', '🍽️', '🍴', '🥄', '🔪', '🫙', '🏺',
        ],
    },
    {
        name: 'Activities',
        icon: 'activity',
        emojis: [
            // Events
            '🎃', '🎄', '🎆', '🎇', '🧨', '✨', '🎈', '🎉', '🎊', '🎋', '🎍', '🎎', '🎏',
            '🎐', '🎑', '🧧', '🎀', '🎁', '🎗️', '🎟️', '🎫',
            // Award medals
            '🎖️', '🏆', '🏅', '🥇', '🥈', '🥉',
            // Sports
            '⚽', '⚾', '🥎', '🏀', '🏐', '🏈', '🏉', '🎾', '🥏', '🎳', '🏏', '🏑', '🏒',
            '🥍', '🏓', '🏸', '🥊', '🥋', '🥅', '⛳', '⛸️', '🎣', '🤿', '🎽', '🎿', '🛷',
            '🥌',
            // Games
            '🎯', '🪀', '🪁', '🔫', '🎱', '🔮', '🪄', '🎮', '🕹️', '🎰', '🧩', '🧸', '🪅',
            '🪩', '🪆', '♠️', '♥️', '♦️', '♣️', '♟️', '🃏', '🀄', '🎴',
            // Arts
            '🎭', '🖼️', '🎨', '🧵', '🪡', '🧶', '🪢',
        ],
    },
    {
        name: 'Travel & Places',
        icon: 'car',
        emojis: [
            // Ground transport
            '🚗', '🚕', '🚙', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐', '🛻', '🚚', '🚛',
            '🚜', '🏍️', '🛵', '🚲', '🛴', '🛹', '🛼', '🚏', '🛣️', '🛤️',
            // Air transport
            '✈️', '🛫', '🛬', '🛩️', '💺', '🛰️', '🚀', '🛸', '🚁', '🛶', '⛵', '🚤', '🛥️',
            '🛳️', '⛴️', '🚢', '⚓', '🪝', '⛽', '🚧', '🚦', '🚥', '🗺️',
            // Buildings
            '🏠', '🏡', '🏘️', '🏚️', '🏗️', '🏢', '🏣', '🏤', '🏥', '🏦', '🏨', '🏩', '🏪',
            '🏫', '🏬', '🏭', '🏯', '🏰', '💒', '🗼', '🗽', '⛪', '🕌', '🛕', '🕍', '⛩️',
            '🕋',
            // Nature places
            '⛰️', '🏔️', '🗻', '🌋', '🏕️', '🏖️', '🏜️', '🏝️', '🏞️', '🗾',
            // Sky & weather
            '🌅', '🌄', '🌠', '🎠', '🎡', '🎢', '🚂', '🚃', '🚄', '🚅', '🚆', '🚇', '🚈',
            '🚉', '🚊', '🚝', '🚞', '🚋', '🚃', '🚎', '🚐', '🚑', '🚒', '🚓', '🚔', '🚕',
            '🛖', '⛺', '🌁', '🌃', '🏙️', '🌆', '🌇', '🌉', '🌌', '🌍', '🌎', '🌏', '🪐',
            '💫', '⭐', '🌟', '✨', '⚡', '☄️', '💥', '🔥', '🌪️', '🌈', '☀️', '🌤️', '⛅',
            '🌥️', '☁️', '🌦️', '🌧️', '⛈️', '🌩️', '🌨️', '❄️', '☃️', '⛄', '🌬️', '💨',
            '💧', '💦', '🫧', '☔', '☂️', '🌊', '🌫️',
        ],
    },
    {
        name: 'Objects',
        icon: 'lightbulb',
        emojis: [
            // Clothing
            '👓', '🕶️', '🥽', '🥼', '🦺', '👔', '👕', '👖', '🧣', '🧤', '🧥', '🧦', '👗',
            '👘', '🥻', '🩱', '🩲', '🩳', '👙', '👚', '🪭', '👛', '👜', '👝', '🎒', '🩴',
            '👞', '👟', '🥾', '🥿', '👠', '👡', '🩰', '👢', '🪮', '👑', '👒', '🎩', '🎓',
            '🧢', '🪖', '⛑️', '💄', '💍', '💼',
            // Sound & music
            '🔇', '🔈', '🔉', '🔊', '📢', '📣', '📯', '🔔', '🔕', '🎼', '🎵', '🎶', '🎙️',
            '🎚️', '🎛️', '🎤', '🎧', '📻', '🎷', '🪗', '🎸', '🎹', '🎺', '🎻', '🪕', '🥁', '🪘', '🪇', '🪈',
            // Technology
            '📱', '📲', '☎️', '📞', '📟', '📠', '🔋', '🪫', '🔌', '💻', '🖥️', '🖨️', '⌨️',
            '🖱️', '🖲️', '💽', '💾', '💿', '📀', '🧮',
            // Camera & film
            '🎥', '🎞️', '📽️', '🎬', '📺', '📷', '📸', '📹', '📼', '🔍', '🔎', '🕯️', '💡',
            '🔦', '🏮', '🪔',
            // Books & paper
            '📔', '📕', '📖', '📗', '📘', '📙', '📚', '📓', '📒', '📃', '📜', '📄', '📰',
            '🗞️', '📑', '🔖', '🏷️', '💰', '🪙', '💴', '💵', '💶', '💷', '💸', '💳', '🧾', '💹',
            // Mail
            '✉️', '📧', '📨', '📩', '📤', '📥', '📦', '📫', '📪', '📬', '📭', '📮', '🗳️',
            // Writing
            '✏️', '✒️', '🖋️', '🖊️', '🖌️', '🖍️', '📝', '📁', '📂', '🗂️', '📅', '📆', '🗒️',
            '🗓️', '📇', '📈', '📉', '📊', '📋', '📌', '📍', '📎', '🖇️', '📏', '📐', '✂️',
            '🗃️', '🗄️', '🗑️',
            // Lock & key
            '🔒', '🔓', '🔏', '🔐', '🔑', '🗝️',
            // Tools
            '🔨', '🪓', '⛏️', '⚒️', '🛠️', '🗡️', '⚔️', '💣', '🪃', '🏹', '🛡️', '🪚', '🔧',
            '🪛', '🔩', '⚙️', '🗜️', '⚖️', '🦯', '🔗', '⛓️', '🪝', '🧰', '🧲', '🪜',
            // Science
            '⚗️', '🧪', '🧫', '🧬', '🔬', '🔭', '📡',
            // Medical
            '💉', '🩸', '💊', '🩹', '🩼', '🩺', '🩻',
            // Household
            '🚪', '🛗', '🪞', '🪟', '🛏️', '🛋️', '🪑', '🚽', '🪠', '🚿', '🛁', '🪤', '🪒',
            '🧴', '🧷', '🧹', '🧺', '🧻', '🪣', '🧼', '🫧', '🪥', '🧽', '🧯', '🛒',
            // Other
            '🚬', '⚰️', '🪦', '⚱️', '🧿', '🪬', '🗿', '🪧', '🪪',
        ],
    },
    {
        name: 'Symbols',
        icon: 'heart',
        emojis: [
            // Hearts
            '❤️', '🩷', '🧡', '💛', '💚', '💙', '🩵', '💜', '🖤', '🩶', '🤍', '🤎', '💔',
            '❤️‍🔥', '❤️‍🩹', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟',
            // Geometric
            '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '🟤', '⚫', '⚪', '🟥', '🟧', '🟨', '🟩',
            '🟦', '🟪', '🟫', '⬛', '⬜', '◼️', '◻️', '◾', '◽', '▪️', '▫️', '🔶', '🔷',
            '🔸', '🔹', '🔺', '🔻', '💠', '🔘', '🔳', '🔲',
            // Arrows
            '⬆️', '↗️', '➡️', '↘️', '⬇️', '↙️', '⬅️', '↖️', '↕️', '↔️', '↩️', '↪️', '⤴️',
            '⤵️', '🔃', '🔄', '🔙', '🔚', '🔛', '🔜', '🔝',
            // Religious
            '☮️', '✝️', '☪️', '🕉️', '☸️', '✡️', '🔯', '🕎', '☯️', '☦️', '🛐', '⛎',
            // Zodiac
            '♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓',
            // AV symbols
            '▶️', '⏩', '⏭️', '⏯️', '◀️', '⏪', '⏮️', '🔼', '⏫', '🔽', '⏬', '⏸️', '⏹️',
            '⏺️', '⏏️', '🎦', '🔅', '🔆', '📶', '🛜', '📳', '📴',
            // Status
            '✅', '☑️', '✔️', '❌', '❎', '➕', '➖', '➗', '✖️', '♾️', '💲', '💱',
            // Information
            '❓', '❔', '❕', '❗', '‼️', '⁉️', '〰️', '💯', '🔱', '⚜️',
            '🔰', '⭕', '✳️', '❇️', '✴️', '❄️', '🆔', '🔀', '🔁', '🔂', '🔃', '🔄',
            // Letters
            '🅰️', '🆎', '🅱️', '🆑', '🆒', '🆓', 'ℹ️', '🆕', '🆖', '🅾️', '🆗', '🅿️',
            '🆘', '🆙', '🆚', '🈁', '🈂️', '🈷️', '🈶', '🈯', '🉐', '🈹', '🈚', '🈲',
            '🉑', '🈸', '🈴', '🈳', '㊗️', '㊙️', '🈺', '🈵',
            // Other symbols
            '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '🟤', '⚫', '⚪', '🔶', '🔷', '🔸', '🔹',
            '▪️', '▫️', '◾', '◽', '◼️', '◻️', '⬛', '⬜', '🔲', '🔳', '🔈', '🔉', '🔊',
            '🔇', '📣', '📢', '🔔', '🔕', '🎵', '🎶', '💹', '🏧', '🚮', '🚰', '♿', '🚹',
            '🚺', '🚻', '🚼', '🚾', '🛂', '🛃', '🛄', '🛅', '⚠️', '🚸', '⛔', '🚫', '🚳',
            '🚭', '🚯', '🚱', '🚷', '📵', '🔞', '☢️', '☣️', '🛑', '⬆️', '↗️', '➡️', '↘️',
        ],
    },
    {
        name: 'Flags',
        icon: 'flag',
        emojis: [
            // Special flags
            '🏳️', '🏴', '🏁', '🚩', '🏳️‍🌈', '🏳️‍⚧️', '🏴‍☠️', '🎌',
            // Countries A-Z
            '🇦🇨', '🇦🇩', '🇦🇪', '🇦🇫', '🇦🇬', '🇦🇮', '🇦🇱', '🇦🇲', '🇦🇴', '🇦🇶', '🇦🇷', '🇦🇸', '🇦🇹', '🇦🇺', '🇦🇼', '🇦🇽', '🇦🇿',
            '🇧🇦', '🇧🇧', '🇧🇩', '🇧🇪', '🇧🇫', '🇧🇬', '🇧🇭', '🇧🇮', '🇧🇯', '🇧🇱', '🇧🇲', '🇧🇳', '🇧🇴', '🇧🇶', '🇧🇷', '🇧🇸', '🇧🇹', '🇧🇻', '🇧🇼', '🇧🇾', '🇧🇿',
            '🇨🇦', '🇨🇨', '🇨🇩', '🇨🇫', '🇨🇬', '🇨🇭', '🇨🇮', '🇨🇰', '🇨🇱', '🇨🇲', '🇨🇳', '🇨🇴', '🇨🇵', '🇨🇷', '🇨🇺', '🇨🇻', '🇨🇼', '🇨🇽', '🇨🇾', '🇨🇿',
            '🇩🇪', '🇩🇬', '🇩🇯', '🇩🇰', '🇩🇲', '🇩🇴', '🇩🇿',
            '🇪🇦', '🇪🇨', '🇪🇪', '🇪🇬', '🇪🇭', '🇪🇷', '🇪🇸', '🇪🇹', '🇪🇺',
            '🇫🇮', '🇫🇯', '🇫🇰', '🇫🇲', '🇫🇴', '🇫🇷',
            '🇬🇦', '🇬🇧', '🇬🇩', '🇬🇪', '🇬🇫', '🇬🇬', '🇬🇭', '🇬🇮', '🇬🇱', '🇬🇲', '🇬🇳', '🇬🇵', '🇬🇶', '🇬🇷', '🇬🇸', '🇬🇹', '🇬🇺', '🇬🇼', '🇬🇾',
            '🇭🇰', '🇭🇲', '🇭🇳', '🇭🇷', '🇭🇹', '🇭🇺',
            '🇮🇨', '🇮🇩', '🇮🇪', '🇮🇱', '🇮🇲', '🇮🇳', '🇮🇴', '🇮🇶', '🇮🇷', '🇮🇸', '🇮🇹',
            '🇯🇪', '🇯🇲', '🇯🇴', '🇯🇵',
            '🇰🇪', '🇰🇬', '🇰🇭', '🇰🇮', '🇰🇲', '🇰🇳', '🇰🇵', '🇰🇷', '🇰🇼', '🇰🇾', '🇰🇿',
            '🇱🇦', '🇱🇧', '🇱🇨', '🇱🇮', '🇱🇰', '🇱🇷', '🇱🇸', '🇱🇹', '🇱🇺', '🇱🇻', '🇱🇾',
            '🇲🇦', '🇲🇨', '🇲🇩', '🇲🇪', '🇲🇫', '🇲🇬', '🇲🇭', '🇲🇰', '🇲🇱', '🇲🇲', '🇲🇳', '🇲🇴', '🇲🇵', '🇲🇶', '🇲🇷', '🇲🇸', '🇲🇹', '🇲🇺', '🇲🇻', '🇲🇼', '🇲🇽', '🇲🇾', '🇲🇿',
            '🇳🇦', '🇳🇨', '🇳🇪', '🇳🇫', '🇳🇬', '🇳🇮', '🇳🇱', '🇳🇴', '🇳🇵', '🇳🇷', '🇳🇺', '🇳🇿',
            '🇴🇲',
            '🇵🇦', '🇵🇪', '🇵🇫', '🇵🇬', '🇵🇭', '🇵🇰', '🇵🇱', '🇵🇲', '🇵🇳', '🇵🇷', '🇵🇸', '🇵🇹', '🇵🇼', '🇵🇾',
            '🇶🇦',
            '🇷🇪', '🇷🇴', '🇷🇸', '🇷🇺', '🇷🇼',
            '🇸🇦', '🇸🇧', '🇸🇨', '🇸🇩', '🇸🇪', '🇸🇬', '🇸🇭', '🇸🇮', '🇸🇯', '🇸🇰', '🇸🇱', '🇸🇲', '🇸🇳', '🇸🇴', '🇸🇷', '🇸🇸', '🇸🇹', '🇸🇻', '🇸🇽', '🇸🇾', '🇸🇿',
            '🇹🇦', '🇹🇨', '🇹🇩', '🇹🇫', '🇹🇬', '🇹🇭', '🇹🇯', '🇹🇰', '🇹🇱', '🇹🇲', '🇹🇳', '🇹🇴', '🇹🇷', '🇹🇹', '🇹🇻', '🇹🇼', '🇹🇿',
            '🇺🇦', '🇺🇬', '🇺🇲', '🇺🇳', '🇺🇸', '🇺🇾', '🇺🇿',
            '🇻🇦', '🇻🇨', '🇻🇪', '🇻🇬', '🇻🇮', '🇻🇳', '🇻🇺',
            '🇼🇫', '🇼🇸',
            '🇽🇰',
            '🇾🇪', '🇾🇹',
            '🇿🇦', '🇿🇲', '🇿🇼',
            // Subdivisions
            '🏴󠁧󠁢󠁥󠁮󠁧󠁿', '🏴󠁧󠁢󠁳󠁣󠁴󠁿', '🏴󠁧󠁢󠁷󠁬󠁳󠁿',
        ],
    },
];

// Quick emoji list for reactions (smaller subset)
export const QUICK_EMOJIS = [
    '👍', '👎', '❤️', '😂', '😮', '😢', '😡', '🎉',
    '🔥', '👀', '💯', '✅', '❌', '⭐', '🙏', '👏',
    '🤔', '😍', '🥳', '💪', '👋', '😊', '🤣', '😎',
];

// Name/keyword tags for search. The picker previously filtered with
// `emoji.includes(query)`, which matches the emoji *character*, so typing a
// name like "heart" found nothing. These tags cover the common searches;
// untagged emojis are still browsable by category, they just don't surface by
// typed name. `searchEmojis` also falls back to the raw-character match so
// pasting an emoji still works.
export const EMOJI_KEYWORDS: Record<string, string> = {
    // Smileys & faces
    '😀': 'grinning happy smile', '😃': 'happy smile grin', '😄': 'happy smile laugh',
    '😁': 'grin beaming', '😆': 'laugh haha', '😅': 'sweat laugh nervous', '🤣': 'rofl rolling laugh lmao',
    '😂': 'joy laugh cry tears lol', '🙂': 'slight smile', '🙃': 'upside down silly',
    '😊': 'smile blush happy', '😇': 'innocent angel halo', '🥰': 'love adore hearts',
    '😍': 'heart eyes love crush', '🤩': 'star struck amazed wow', '😘': 'kiss blow',
    '😗': 'kiss', '😚': 'kiss', '😙': 'kiss', '😋': 'yum tasty tongue', '😛': 'tongue silly',
    '😜': 'tongue wink silly', '😝': 'tongue silly', '🤪': 'crazy zany goofy', '🤗': 'hug hugging',
    '🤔': 'think thinking hmm', '🤐': 'zip mouth quiet', '🤨': 'raised eyebrow suspicious',
    '😐': 'neutral meh', '😑': 'expressionless', '😶': 'no mouth silent', '🙄': 'eye roll annoyed',
    '😏': 'smirk smug', '😒': 'unamused meh', '😞': 'sad disappointed', '😔': 'pensive sad',
    '😟': 'worried', '😕': 'confused', '🙁': 'frown sad', '😣': 'persevere', '😖': 'confounded',
    '😫': 'tired weary', '😩': 'weary tired', '🥱': 'yawn tired bored sleepy', '😤': 'huff triumph',
    '😠': 'angry mad', '😡': 'rage angry mad furious', '🤬': 'swear curse angry', '😳': 'flushed embarrassed shock',
    '🥺': 'pleading puppy eyes beg', '😢': 'cry sad tear', '😭': 'sob cry bawl',
    '😱': 'scream fear shock', '😨': 'fear scared', '😰': 'anxious sweat', '😥': 'sad relieved',
    '😓': 'sweat downcast', '🤥': 'lie liar pinocchio', '😴': 'sleep zzz tired', '😪': 'sleepy',
    '😌': 'relieved calm', '🤤': 'drool', '😷': 'mask sick', '🤒': 'sick ill thermometer',
    '🤕': 'hurt injured bandage', '🤢': 'sick nausea gross', '🤮': 'vomit puke sick',
    '🤧': 'sneeze sick', '🥵': 'hot heat sweat', '🥶': 'cold freeze frozen', '🥴': 'woozy drunk',
    '😵': 'dizzy dead knocked', '🤯': 'mind blown shocked explode', '🤠': 'cowboy',
    '🥳': 'party celebrate hat', '😎': 'cool sunglasses', '🤓': 'nerd geek glasses',
    '🧐': 'monocle inspect', '🥸': 'disguise', '😈': 'devil evil smirk', '👿': 'devil angry evil',
    '💀': 'skull dead death', '☠️': 'skull crossbones death poison', '💩': 'poop poo crap',
    '🤡': 'clown', '👹': 'ogre monster', '👺': 'goblin', '👻': 'ghost boo spooky',
    '👽': 'alien ufo', '👾': 'alien invader game', '🤖': 'robot bot', '🎃': 'pumpkin halloween jackolantern',
    '😺': 'cat happy', '😸': 'cat grin', '😹': 'cat joy laugh', '😻': 'cat love heart',
    '🙀': 'cat shock', '😿': 'cat cry sad', '🙈': 'monkey see no evil', '🙉': 'monkey hear no evil',
    '🙊': 'monkey speak no evil',
    // Hearts & emotion symbols
    '❤️': 'red heart love', '🩷': 'pink heart love', '🧡': 'orange heart', '💛': 'yellow heart',
    '💚': 'green heart', '💙': 'blue heart', '💜': 'purple heart', '🖤': 'black heart',
    '🤍': 'white heart', '🤎': 'brown heart', '💔': 'broken heart heartbreak', '❤️‍🔥': 'heart fire burning love',
    '❤️‍🩹': 'mending heart healing', '💕': 'two hearts love', '💞': 'revolving hearts love',
    '💓': 'beating heart love', '💗': 'growing heart love', '💖': 'sparkling heart love',
    '💘': 'heart arrow cupid love', '💝': 'heart gift ribbon love', '💟': 'heart decoration',
    '💌': 'love letter', '💋': 'kiss lips lipstick', '💯': 'hundred perfect score keep it',
    '💢': 'anger comic mad', '💥': 'boom explosion collision', '💫': 'dizzy stars',
    '💦': 'sweat water droplets splash', '💨': 'dash wind fast', '💬': 'speech bubble talk chat',
    '💭': 'thought bubble think', '💤': 'sleep zzz snore', '👁️': 'eye',
    // Hands & body
    '👍': 'thumbs up like yes approve good', '👎': 'thumbs down dislike no bad',
    '👌': 'ok perfect', '🤌': 'pinch italian', '✌️': 'peace victory two', '🤞': 'fingers crossed luck hope',
    '🤟': 'love you hand', '🤘': 'rock horns metal', '🤙': 'call me shaka hang loose',
    '👈': 'point left', '👉': 'point right', '👆': 'point up', '👇': 'point down',
    '🖕': 'middle finger rude', '☝️': 'point up index', '✋': 'hand stop raised high five',
    '🖐️': 'hand fingers', '🖖': 'vulcan spock', '👋': 'wave hi hello bye goodbye',
    '👊': 'fist bump punch', '✊': 'fist raised power', '🤛': 'fist bump left', '🤜': 'fist bump right',
    '👏': 'clap applause bravo', '🙌': 'raise hands praise celebrate', '👐': 'open hands',
    '🤲': 'palms up pray', '🤝': 'handshake deal agree', '🙏': 'pray thanks please hope namaste',
    '✍️': 'write writing hand', '💅': 'nails manicure', '🤳': 'selfie', '💪': 'muscle strong flex biceps',
    '🫶': 'heart hands love', '🫰': 'finger heart love', '👀': 'eyes look watch see',
    '👶': 'baby infant', '🧒': 'child', '🧑': 'person', '👨': 'man', '👩': 'woman',
    '👮': 'police cop officer', '🕵️': 'detective spy', '🥷': 'ninja', '👷': 'construction worker builder',
    '🤴': 'prince', '👸': 'princess', '🦸': 'superhero hero', '🦹': 'supervillain villain',
    '🧙': 'wizard mage', '🧚': 'fairy', '🧛': 'vampire', '🎅': 'santa claus christmas', '🤶': 'mrs claus christmas',
    // Animals & nature
    '🐶': 'dog puppy pup', '🐕': 'dog', '🐺': 'wolf', '🦊': 'fox', '🦝': 'raccoon',
    '🐱': 'cat kitten kitty', '🐈': 'cat', '🦁': 'lion', '🐯': 'tiger', '🐴': 'horse',
    '🦄': 'unicorn', '🦓': 'zebra', '🦌': 'deer', '🐮': 'cow', '🐷': 'pig', '🐗': 'boar',
    '🐭': 'mouse', '🐹': 'hamster', '🐰': 'rabbit bunny', '🐻': 'bear', '🐨': 'koala',
    '🐼': 'panda', '🦥': 'sloth', '🦦': 'otter', '🦘': 'kangaroo', '🐸': 'frog',
    '🐵': 'monkey', '🐒': 'monkey', '🦍': 'gorilla', '🐔': 'chicken hen', '🐓': 'rooster',
    '🐣': 'chick hatching', '🐥': 'chick baby', '🐦': 'bird', '🐧': 'penguin', '🕊️': 'dove peace bird',
    '🦅': 'eagle bird', '🦆': 'duck', '🦉': 'owl', '🦚': 'peacock', '🦜': 'parrot',
    '🐢': 'turtle tortoise', '🐍': 'snake serpent', '🐲': 'dragon', '🐉': 'dragon',
    '🦕': 'dinosaur', '🦖': 'trex dinosaur', '🐳': 'whale', '🐋': 'whale', '🐬': 'dolphin',
    '🐟': 'fish', '🐠': 'fish tropical', '🦈': 'shark', '🐙': 'octopus', '🦀': 'crab',
    '🦞': 'lobster', '🦐': 'shrimp', '🦋': 'butterfly', '🐛': 'bug caterpillar', '🐝': 'bee honeybee',
    '🐞': 'ladybug beetle', '🦗': 'cricket', '🕷️': 'spider', '🦂': 'scorpion', '🐌': 'snail',
    '🦠': 'microbe germ virus', '🌸': 'blossom flower cherry', '🌹': 'rose flower',
    '🌻': 'sunflower flower', '🌷': 'tulip flower', '🌵': 'cactus', '🌲': 'tree evergreen',
    '🌳': 'tree', '🌴': 'palm tree', '🍀': 'clover luck lucky four leaf', '🍁': 'maple leaf autumn fall',
    '🍂': 'leaves autumn fall', '🔥': 'fire flame lit hot burn',
    // Food & drink
    '🍎': 'apple red fruit', '🍏': 'apple green', '🍌': 'banana', '🍓': 'strawberry',
    '🍒': 'cherry cherries', '🍑': 'peach', '🍉': 'watermelon', '🍇': 'grapes',
    '🍊': 'orange tangerine', '🍋': 'lemon', '🍍': 'pineapple', '🥭': 'mango', '🥥': 'coconut',
    '🥝': 'kiwi', '🍅': 'tomato', '🥑': 'avocado', '🍆': 'eggplant aubergine', '🥕': 'carrot',
    '🌽': 'corn', '🌶️': 'pepper chili spicy hot', '🥦': 'broccoli', '🍄': 'mushroom',
    '🍞': 'bread', '🥐': 'croissant', '🥖': 'baguette bread', '🧀': 'cheese', '🥚': 'egg',
    '🍳': 'egg fried cooking', '🥩': 'steak meat', '🍗': 'chicken drumstick meat', '🥓': 'bacon',
    '🍔': 'burger hamburger', '🍟': 'fries chips', '🍕': 'pizza', '🌭': 'hotdog', '🥪': 'sandwich',
    '🌮': 'taco', '🌯': 'burrito', '🥗': 'salad', '🍿': 'popcorn', '🧂': 'salt',
    '🍜': 'ramen noodles soup', '🍝': 'pasta spaghetti', '🍣': 'sushi', '🍱': 'bento',
    '🍦': 'ice cream soft serve', '🍨': 'ice cream', '🍩': 'donut doughnut', '🍪': 'cookie',
    '🎂': 'birthday cake', '🍰': 'cake slice', '🧁': 'cupcake', '🥧': 'pie', '🍫': 'chocolate',
    '🍬': 'candy sweet', '🍭': 'lollipop candy', '🍯': 'honey', '🍼': 'baby bottle milk',
    '🥛': 'milk glass', '☕': 'coffee tea hot drink', '🍵': 'tea green', '🍶': 'sake',
    '🍾': 'champagne bottle', '🍷': 'wine', '🍸': 'cocktail martini', '🍹': 'cocktail tropical',
    '🍺': 'beer', '🍻': 'beers cheers', '🥂': 'champagne cheers toast', '🥃': 'whiskey',
    '🥤': 'soda drink cup', '🧋': 'bubble tea boba', '🧃': 'juice box', '🧊': 'ice cube',
    // Activities & sports
    '⚽': 'soccer football', '🏀': 'basketball', '🏈': 'football american', '⚾': 'baseball',
    '🥎': 'softball', '🎾': 'tennis', '🏐': 'volleyball', '🏉': 'rugby', '🎱': 'pool 8 ball billiards',
    '🏓': 'ping pong table tennis', '🏸': 'badminton', '🥊': 'boxing glove', '⛳': 'golf',
    '🎣': 'fishing', '🎯': 'target dart bullseye', '🎳': 'bowling', '🎮': 'game controller gaming video',
    '🕹️': 'joystick game', '🎲': 'dice game', '🧩': 'puzzle jigsaw', '♟️': 'chess',
    '🎸': 'guitar', '🎹': 'piano keyboard', '🎺': 'trumpet', '🎷': 'saxophone', '🥁': 'drums',
    '🎤': 'mic microphone sing karaoke', '🎧': 'headphones music', '🎼': 'music score notes',
    '🎵': 'music note', '🎶': 'music notes', '🎨': 'art paint palette', '🎭': 'theater masks drama',
    '🎬': 'movie clapper film action', '🎪': 'circus tent', '🏆': 'trophy win champion award',
    '🥇': 'gold medal first place', '🥈': 'silver medal second', '🥉': 'bronze medal third',
    '🏅': 'medal award', '🎖️': 'medal military', '🎉': 'party tada celebrate hooray',
    '🎊': 'confetti party celebrate', '🎈': 'balloon party', '🎁': 'gift present box',
    '🎀': 'bow ribbon', '🎗️': 'ribbon awareness', '🎏': 'carp streamer', '🧨': 'firecracker',
    // Travel & places
    '🚗': 'car auto vehicle', '🚕': 'taxi cab', '🚙': 'suv car', '🚌': 'bus', '🚑': 'ambulance',
    '🚓': 'police car', '🚒': 'fire truck engine', '🏎️': 'race car racing', '🏍️': 'motorcycle',
    '🛵': 'scooter moped', '🚲': 'bike bicycle', '🛴': 'scooter kick', '🚀': 'rocket launch space',
    '✈️': 'plane airplane flight travel', '🚁': 'helicopter', '🛸': 'ufo alien saucer',
    '⛵': 'sailboat boat', '🚢': 'ship cruise', '🚤': 'speedboat boat', '⚓': 'anchor',
    '🏠': 'house home', '🏡': 'house home garden', '🏢': 'office building', '🏥': 'hospital',
    '🏦': 'bank', '🏨': 'hotel', '🏫': 'school', '🏰': 'castle', '🗽': 'statue liberty new york',
    '🗼': 'tower eiffel', '⛰️': 'mountain', '🏔️': 'mountain snow', '🌋': 'volcano',
    '🏖️': 'beach sand', '🏝️': 'island tropical', '🏕️': 'camping tent', '🎡': 'ferris wheel',
    '🎢': 'roller coaster', '🎠': 'carousel merry go round',
    // Sky & weather
    '🌅': 'sunrise', '🌄': 'sunrise mountain', '🌇': 'sunset city', '🌃': 'night city stars',
    '⭐': 'star', '🌟': 'star glowing shine', '✨': 'sparkles shine stars magic', '⚡': 'lightning bolt zap electric',
    '☄️': 'comet meteor', '🌈': 'rainbow', '☀️': 'sun sunny weather',
    '🌤️': 'sun cloud partly', '⛅': 'cloud sun partly', '☁️': 'cloud cloudy', '🌧️': 'rain rainy',
    '⛈️': 'storm thunder lightning', '🌩️': 'lightning storm', '🌨️': 'snow', '❄️': 'snowflake snow cold winter',
    '☃️': 'snowman winter', '⛄': 'snowman winter', '🌬️': 'wind blow', '🌪️': 'tornado twister',
    '🌊': 'wave ocean sea water', '💧': 'droplet water drop', '🌍': 'earth world globe europe africa',
    '🌎': 'earth world globe americas', '🌏': 'earth world globe asia', '🪐': 'planet saturn ringed',
    '🌙': 'moon crescent night', '🌕': 'full moon',
    // Objects & tech
    '📱': 'phone mobile cell smartphone', '💻': 'laptop computer', '🖥️': 'desktop computer monitor',
    '⌨️': 'keyboard', '🖱️': 'mouse computer', '💡': 'idea light bulb', '🔦': 'flashlight torch',
    '📷': 'camera photo', '📸': 'camera flash photo', '🎥': 'video camera movie', '📺': 'tv television',
    '🔋': 'battery', '🔌': 'plug power electric', '💾': 'save disk floppy', '💿': 'cd disc dvd',
    '📚': 'books library read', '📖': 'book open read', '📝': 'memo note write pencil',
    '✏️': 'pencil write', '📌': 'pin pushpin', '📎': 'paperclip attach', '✂️': 'scissors cut',
    '🔒': 'lock locked secure private', '🔓': 'unlock open', '🔑': 'key', '🗝️': 'key old',
    '🔨': 'hammer tool', '🔧': 'wrench tool fix', '🛠️': 'tools hammer wrench', '⚙️': 'gear settings cog config',
    '🧲': 'magnet', '💰': 'money bag cash', '💵': 'dollar money cash bill', '💳': 'credit card payment',
    '💎': 'diamond gem jewel', '⌚': 'watch time', '⏰': 'alarm clock time wake', '⏳': 'hourglass time wait',
    '💣': 'bomb explosive', '💊': 'pill medicine drug', '💉': 'syringe shot vaccine needle',
    '🩹': 'bandage plaster', '🌡️': 'thermometer temperature', '🔬': 'microscope science',
    '🔭': 'telescope space', '📡': 'satellite dish antenna', '🔍': 'search magnify zoom find',
    '🔎': 'search magnify zoom find', '🕯️': 'candle', '🧼': 'soap wash', '🧻': 'toilet paper roll',
    '🚽': 'toilet', '🛁': 'bath tub', '🛏️': 'bed sleep', '🪑': 'chair', '🚪': 'door',
    '🛒': 'shopping cart trolley', '📅': 'calendar date', '📆': 'calendar date', '📈': 'chart up growth stonks',
    '📉': 'chart down decline loss', '📊': 'bar chart graph stats', '📋': 'clipboard',
    // Symbols
    '✅': 'check tick done yes correct complete green', '☑️': 'check tick box done', '✔️': 'check tick done',
    '❌': 'cross x no wrong incorrect red', '❎': 'cross x no', '➕': 'plus add', '➖': 'minus subtract',
    '✖️': 'multiply times x', '➗': 'divide', '❓': 'question mark help', '❗': 'exclamation warning',
    '‼️': 'exclamation double', '⚠️': 'warning caution alert', '🚫': 'no ban prohibited forbidden',
    '⛔': 'no entry stop forbidden', '🔞': 'no under 18 adult nsfw', '☢️': 'radioactive nuclear',
    '☣️': 'biohazard toxic', '♻️': 'recycle recycling', '⭕': 'circle o correct', '🔴': 'red circle dot',
    '🟠': 'orange circle', '🟡': 'yellow circle', '🟢': 'green circle', '🔵': 'blue circle',
    '🟣': 'purple circle', '⚫': 'black circle', '⚪': 'white circle', '🟥': 'red square',
    '🟩': 'green square', '🟦': 'blue square', '🔺': 'triangle up red', '🔻': 'triangle down',
    '🔔': 'bell notification alert ring', '🔕': 'mute bell silent no notification', '📢': 'loudspeaker announce',
    '📣': 'megaphone announce cheer', '➡️': 'arrow right', '⬅️': 'arrow left', '⬆️': 'arrow up',
    '⬇️': 'arrow down', '🔄': 'refresh reload sync arrows', '🔁': 'repeat loop', '▶️': 'play',
    '⏸️': 'pause', '⏹️': 'stop', '♾️': 'infinity forever', '♠️': 'spades card', '♥️': 'hearts card',
    '♦️': 'diamonds card', '♣️': 'clubs card', '⚛️': 'atom science physics', '☮️': 'peace',
    '☯️': 'yin yang balance', '✝️': 'cross christian', '☪️': 'islam muslim star crescent',
    '✡️': 'star of david jewish', '🕉️': 'om hindu', '🆗': 'ok', '🆒': 'cool', '🆕': 'new',
    '🆓': 'free', '🅱️': 'b button', '💲': 'dollar money sign', '™️': 'trademark', '©️': 'copyright',
    '®️': 'registered',
    // Flags
    '🏳️': 'white flag surrender', '🏴': 'black flag', '🏁': 'checkered flag finish race',
    '🚩': 'red flag warning', '🏳️‍🌈': 'pride rainbow flag lgbt gay', '🏳️‍⚧️': 'trans flag transgender',
    '🏴‍☠️': 'pirate flag skull', '🎌': 'crossed flags japan',
    '🇺🇸': 'usa america united states flag', '🇬🇧': 'uk britain england united kingdom flag',
    '🇨🇦': 'canada flag', '🇯🇵': 'japan flag', '🇩🇪': 'germany flag', '🇫🇷': 'france flag',
    '🇮🇹': 'italy flag', '🇪🇸': 'spain flag', '🇧🇷': 'brazil flag', '🇮🇳': 'india flag',
    '🇨🇳': 'china flag', '🇰🇷': 'korea flag', '🇷🇺': 'russia flag', '🇲🇽': 'mexico flag',
    '🇦🇺': 'australia flag', '🇳🇱': 'netherlands flag', '🇸🇪': 'sweden flag', '🇮🇪': 'ireland flag',
};

// De-duplicated flat list (some emojis appear in multiple categories).
const ALL_EMOJIS: string[] = Array.from(
    new Set(EMOJI_CATEGORIES.flatMap((c) => c.emojis)),
);

/**
 * Search emojis by name/keyword. Falls back to a raw-character match so that
 * pasting an actual emoji still finds it. Returns [] for an empty query.
 */
export function searchEmojis(query: string): string[] {
    const raw = query.trim();
    if (!raw) return [];
    const q = raw.toLowerCase();
    return ALL_EMOJIS.filter((e) => {
        if (e.includes(raw)) return true; // pasted-emoji search
        const kw = EMOJI_KEYWORDS[e];
        return kw ? kw.includes(q) : false;
    });
}
