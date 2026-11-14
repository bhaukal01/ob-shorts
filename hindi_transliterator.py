"""Hindi (Devanagari) to Hinglish (Roman Script) Transliterator.

Converts Devanagari text into conversational Romanized Hindi ("Hinglish") while
strictly preserving Whisper's word-level timestamps and segment structure for
synchronized video subtitles.

Examples:
    "नमस्ते दोस्तों" -> "Namaste dosto"
    "क्या हाल है" -> "Kya haal hai"
    "आज हम खेल रहे हैं" -> "Aaj hum khel rahe hain"
"""
import re
from typing import Any, Dict, List

# Common conversational words dictionary for natural spelling
_COMMON_WORDS: Dict[str, str] = {
    "नमस्ते": "Namaste",
    "नमस्कार": "Namaskar",
    "दोस्तों": "dosto",
    "दोस्त": "dost",
    "भाई": "bhai",
    "भाइयों": "bhaiyo",
    "क्या": "kya",
    "क्यों": "kyon",
    "कैसे": "kaise",
    "कैसा": "kaisa",
    "कैसी": "kaisi",
    "कब": "kab",
    "कहाँ": "kahan",
    "कहा": "kaha",
    "यहाँ": "yahan",
    "वहाँ": "wahan",
    "जहाँ": "jahan",
    "है": "hai",
    "हैं": "hain",
    "हो": "ho",
    "हूँ": "hoon",
    "था": "tha",
    "थी": "thi",
    "थे": "the",
    "मैं": "main",
    "मुझे": "mujhe",
    "मेरा": "mera",
    "मेरी": "meri",
    "मेरे": "mere",
    "हम": "hum",
    "हमें": "humein",
    "हमारा": "hamara",
    "हमारी": "hamari",
    "हमारे": "hamare",
    "तुम": "tum",
    "तुम्हें": "tumhein",
    "तुम्हारा": "tumhara",
    "तुम्हारी": "tumhari",
    "तुम्हारे": "tumhare",
    "आप": "aap",
    "आपको": "aapko",
    "आपका": "aapka",
    "आपकी": "aapki",
    "आपके": "aapke",
    "वो": "wo",
    "वह": "woh",
    "वे": "ve",
    "यह": "yeh",
    "ये": "ye",
    "इस": "is",
    "उस": "us",
    "इन": "in",
    "उन": "un",
    "इसका": "iska",
    "उसका": "uska",
    "इनका": "inka",
    "उनका": "unka",
    "नहीं": "nahi",
    "ना": "na",
    "हाँ": "haan",
    "और": "aur",
    "लेकिन": "lekin",
    "मगर": "magar",
    "पर": "par",
    "अगर": "agar",
    "तो": "to",
    "भी": "bhi",
    "ही": "hi",
    "तक": "tak",
    "से": "se",
    "को": "ko",
    "में": "mein",
    "पे": "pe",
    "का": "ka",
    "की": "ki",
    "के": "ke",
    "कर": "kar",
    "करना": "karna",
    "करते": "karte",
    "करता": "karta",
    "करती": "karti",
    "करो": "karo",
    "करें": "karein",
    "किया": "kiya",
    "किये": "kiye",
    "कीजिये": "kijiye",
    "होगा": "hoga",
    "होगी": "hogi",
    "होंगे": "honge",
    "रहा": "raha",
    "रही": "rahi",
    "रहे": "rahe",
    "गया": "gaya",
    "गई": "gayi",
    "गए": "gaye",
    "जा": "ja",
    "जाना": "jana",
    "जाता": "jata",
    "जाती": "jati",
    "जाते": "jate",
    "आ": "aa",
    "आना": "aana",
    "आया": "aaya",
    "आये": "aaye",
    "आई": "aayi",
    "बोल": "bol",
    "बोला": "bola",
    "बोली": "boli",
    "बोले": "bole",
    "देख": "dekh",
    "देखो": "dekho",
    "देखा": "dekha",
    "देखी": "dekhi",
    "देखे": "dekhe",
    "सुन": "sun",
    "सुनो": "suno",
    "सुना": "suna",
    "खेल": "khel",
    "खेलो": "khelo",
    "खेला": "khela",
    "बहुत": "bahut",
    "ज्यादा": "zyada",
    "कम": "kam",
    "अच्छा": "achha",
    "अच्छी": "achhi",
    "अच्छे": "achhe",
    "बुरा": "bura",
    "बुरी": "buri",
    "बुरे": "bure",
    "बड़ा": "bada",
    "बड़ी": "badi",
    "बड़े": "bade",
    "छोटा": "chhota",
    "छोटी": "chhoti",
    "छोटे": "chhote",
    "पहला": "pehla",
    "पहली": "pehli",
    "पहले": "pehle",
    "दूसरा": "doosra",
    "दूसरी": "doosri",
    "दूसरे": "doosre",
    "बात": "baat",
    "बातें": "baatein",
    "काम": "kaam",
    "चीज": "cheez",
    "चीजें": "cheezein",
    "वक्त": "waqt",
    "समय": "samay",
    "दिन": "din",
    "रात": "raat",
    "साल": "saal",
    "घर": "ghar",
    "लोग": "log",
    "लोगो": "logo",
    "लोगों": "logon",
    "वीडियो": "video",
    "गेम": "game",
    "लाइव": "live",
    "चैनल": "channel",
    "सब्सक्राइब": "subscribe",
    "लाइक": "like",
    "शेयर": "share",
    "कमेंट": "comment",
    "स्ट्रीम": "stream",
    "शॉर्ट्स": "shorts",
    "किल": "kill",
    "ओपी": "OP",
    "क्लच": "clutch",
    "हेडशॉट": "headshot",
}

# Independent vowels
_INDEPENDENT_VOWELS = {
    'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo',
    'ऋ': 'ri', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au',
}

# Matras (dependent vowels)
_MATRAS = {
    'ा': 'aa', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo',
    'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au',
}

# Consonants (with base consonant romanization)
_CONSONANTS = {
    'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'ng',
    'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'ny',
    'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
    'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
    'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
    'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v',
    'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h',
    # Nuqta variants
    'क़': 'q', 'ख़': 'kh', 'ग़': 'gh', 'ज़': 'z', 'ड़': 'r', 'ढ़': 'rh', 'फ़': 'f',
}

_VIRAMA = '्'
_ANUSVARA = 'ं'
_CHANDRABINDU = 'ँ'
_VISARGA = 'ः'
_NUKTA = '़'

_DEVANAGARI_REGEX = re.compile(r'[\u0900-\u097F]+')


def transliterate_word(word: str) -> str:
    """Transliterates a single Devanagari word into Roman Hinglish.
    
    Checks dictionary first, falls back to phonetic parser with schwa-deletion.
    """
    if not word:
        return ""
    
    # Clean word for dictionary check (strip punctuation)
    m = re.match(r'^([^\w\u0900-\u097F]*)([\u0900-\u097F]+)([^\w\u0900-\u097F]*)$', word)
    prefix, core, suffix = ("", word, "")
    if m:
        prefix, core, suffix = m.groups()

    if core in _COMMON_WORDS:
        translit_core = _COMMON_WORDS[core]
        return f"{prefix}{translit_core}{suffix}"

    # Lowercase dictionary check
    if core.lower() in _COMMON_WORDS:
        translit_core = _COMMON_WORDS[core.lower()]
        return f"{prefix}{translit_core}{suffix}"

    # Phonetic character-by-character parser
    chars = list(core)
    n = len(chars)
    out: List[str] = []
    i = 0

    while i < n:
        c = chars[i]

        # Handle nuqta merged with previous or following
        if i + 1 < n and chars[i + 1] == _NUKTA:
            combined = c + _NUKTA
            if combined in _CONSONANTS:
                base = _CONSONANTS[combined]
                i += 2
                # Check what follows
                if i < n:
                    nxt = chars[i]
                    if nxt == _VIRAMA:
                        out.append(base)
                        i += 1
                    elif nxt in _MATRAS:
                        out.append(base + _MATRAS[nxt])
                        i += 1
                    else:
                        out.append(base + 'a')
                else:
                    # Final consonant: schwa deletion
                    out.append(base)
                continue

        if c in _INDEPENDENT_VOWELS:
            out.append(_INDEPENDENT_VOWELS[c])
            i += 1
        elif c in _CONSONANTS:
            base = _CONSONANTS[c]
            i += 1
            if i < n:
                nxt = chars[i]
                if nxt == _VIRAMA:
                    out.append(base)
                    i += 1
                elif nxt in _MATRAS:
                    out.append(base + _MATRAS[nxt])
                    i += 1
                elif nxt == _ANUSVARA or nxt == _CHANDRABINDU:
                    out.append(base + 'an')
                    i += 1
                else:
                    # Inherent 'a'
                    out.append(base + 'a')
            else:
                # Word-final consonant: apply modern Hindi schwa deletion
                # (e.g., 'घर' -> 'ghar', not 'ghara')
                out.append(base)
        elif c in _MATRAS:
            out.append(_MATRAS[c])
            i += 1
        elif c == _ANUSVARA or c == _CHANDRABINDU:
            out.append('n')
            i += 1
        elif c == _VISARGA:
            out.append('h')
            i += 1
        else:
            out.append(c)
            i += 1

    translit_core = "".join(out)
    return f"{prefix}{translit_core}{suffix}"


def transliterate_text(text: str) -> str:
    """Transliterates Devanagari text inside a sentence to Hinglish."""
    if not text:
        return ""

    def _replace_match(match: re.Match) -> str:
        devanagari_token = match.group(0)
        return transliterate_word(devanagari_token)

    return _DEVANAGARI_REGEX.sub(_replace_match, text)


def transliterate_transcript(transcript: Dict[str, Any]) -> Dict[str, Any]:
    """Transliterates a full Whisper transcript dictionary into Hinglish.
    
    Preserves exact word timestamps, segment bounds, and structural keys.
    """
    if not transcript or not isinstance(transcript, dict):
        return transcript

    new_transcript = dict(transcript)
    segments = transcript.get("segments", [])
    new_segments = []

    for seg in segments:
        new_seg = dict(seg)
        # Transliterate words while preserving timing
        words = seg.get("words", [])
        new_words = []
        seg_word_texts = []

        for w in words:
            new_w = dict(w)
            original_word = w.get("word", "")
            # Preserve leading/trailing spaces
            l_spaces = len(original_word) - len(original_word.lstrip(" "))
            r_spaces = len(original_word) - len(original_word.rstrip(" "))
            trimmed = original_word.strip()

            transliterated = transliterate_text(trimmed)
            new_w["word"] = (" " * l_spaces) + transliterated + (" " * r_spaces)
            new_words.append(new_w)
            seg_word_texts.append(new_w["word"])

        new_seg["words"] = new_words
        if new_words:
            new_seg["text"] = "".join(seg_word_texts).strip()
        elif "text" in seg:
            new_seg["text"] = transliterate_text(seg["text"])

        new_segments.append(new_seg)

    new_transcript["segments"] = new_segments
    if new_segments:
        new_transcript["text"] = " ".join(s.get("text", "") for s in new_segments)
    elif "text" in transcript:
        new_transcript["text"] = transliterate_text(transcript["text"])

    return new_transcript

