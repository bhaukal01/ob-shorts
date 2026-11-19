"""
niche_tags.py - Specific Niche & Game Hashtag Engine for OpenShorts

Extracts and generates niche-specific, high-retention hashtags based on:
1. Source video title (e.g. GTA 6, Minecraft, Python, Crypto, CarryMinati)
2. Clip title and transcript hook
3. Content category and creators
"""

import re
from typing import List, Set, Dict, Any

# Game keywords mapped to specific hashtags
GAME_KEYWORD_MAP = {
    # Grand Theft Auto
    r"\bgta\s*6\b|\bgta\s*vi\b": ["#GTA6", "#GTAVI", "#GrandTheftAuto6", "#GTAVIViral"],
    r"\bgta\s*5\b|\bgta\s*v\b|\bgta\s*rp\b|\bgta\s*online\b": ["#GTA5", "#GTARP", "#GrandTheftAuto", "#GTAV"],
    r"\bgta\b": ["#GTA", "#GrandTheftAuto", "#GamingShorts"],
    # Minecraft
    r"\bminecraft\b|\bmcpe\b|\bbedrock\b": ["#Minecraft", "#MinecraftShorts", "#MinecraftMemes", "#MCPE"],
    # Shooter & Battle Royale
    r"\bvalorant\b|\bval\b": ["#Valorant", "#ValorantClips", "#ValorantShorts", "#RiotGames"],
    r"\bbgmi\b|\bpubg\b|\bbattlegrounds\b": ["#BGMI", "#PUBG", "#BGMIShorts", "#PUBGMobile"],
    r"\bfree\s*fire\b|\bff\b": ["#FreeFire", "#FreeFireIndia", "#FreeFireShorts"],
    r"\bfortnite\b": ["#Fortnite", "#FortniteClips", "#FortniteShorts"],
    r"\broblox\b": ["#Roblox", "#RobloxShorts", "#RobloxMemes"],
    r"\bcall\s*of\s*duty\b|\bwarzone\b|\bcod\b|\bcodm\b": ["#CallOfDuty", "#Warzone", "#CODMobile"],
    r"\bcounter\s*strike\b|\bcsgo\b|\bcs2\b": ["#CS2", "#CSGO", "#CounterStrike"],
    r"\bapex\s*legends\b|\bapex\b": ["#ApexLegends", "#ApexClips"],
    r"\bleague\s*of\s*legends\b|\blol\b": ["#LeagueOfLegends", "#LoL"],
    r"\belden\s*ring\b|\bdark\s*souls\b|\bsoulsborne\b": ["#EldenRing", "#DarkSouls"],
    r"\bfifa\b|\bfc\s*24\b|\bfc\s*25\b|\beafc\b": ["#FC25", "#FIFA", "#EAFC", "#FootballGaming"],
    r"\bgenshin\b|\bgenshin\s*impact\b": ["#GenshinImpact", "#Genshin"],
    r"\boverwatch\b": ["#Overwatch2", "#Overwatch"],
    r"\bracket\s*league\b": ["#RocketLeague", "#RL"],
    r"\bcyberpunk\b": ["#Cyberpunk2077"],
    r"\brdr2\b|\bred\s*dead\b": ["#RDR2", "#RedDeadRedemption2"],
    r"\bgod\s*of\s*war\b": ["#GodOfWar"],
    r"\bclash\s*royale\b|\bclash\s*of\s*clans\b": ["#ClashRoyale", "#ClashOfClans", "#MobileGaming"],
    r"\bhorror\s*game\b|\bgranny\b|\bfnaf\b": ["#HorrorGaming", "#FNAF", "#ScaryGaming"],
}

# Creator / Streamer keywords
CREATOR_KEYWORD_MAP = {
    r"\brachitroo\b": ["#Rachitroo", "#Rackathon"],
    r"\bcarryminati\b|\bcarryislive\b": ["#CarryMinati", "#CarryIsLive"],
    r"\btechno\s*gamerz\b|\bujjwalgamer\b": ["#TechnoGamerz", "#UjjwalGamer"],
    r"\btotal\s*gaming\b|\bajjubhai\b": ["#TotalGaming", "#Ajjubhai"],
    r"\bmortal\b": ["#Mortal", "#SouLMortal"],
    r"\bscout\b|\bscoutop\b": ["#Scout", "#ScoutOP"],
    r"\bdynamo\b|\bdynamoop\b": ["#DynamoGaming", "#DynamoOP"],
    r"\bmythpat\b": ["#Mythpat"],
    r"\btriggered\s*insaan\b|\blive\s*insaan\b": ["#TriggeredInsaan", "#LiveInsaan"],
    r"\bfukra\s*insaan\b": ["#FukraInsaan"],
    r"\bbeastboyshub\b": ["#BeastBoyShub"],
    r"\bgamerfleet\b": ["#GamerFleet"],
    r"\bishowspeed\b|\bspeed\b": ["#IShowSpeed", "#Speed"],
    r"\bkai\s*cenat\b": ["#KaiCenat", "#AMP"],
    r"\bxqc\b": ["#xQc"],
    r"\bmrbeast\b": ["#MrBeast"],
    r"\bpewdiepie\b": ["#PewDiePie"],
}

# Topic & Niche keywords
NICHE_KEYWORD_MAP = {
    # Tech & Coding
    r"\bpython\b|\bjavascript\b|\btypescript\b|\breact\b|\bnextjs\b|\bcoding\b|\bdeveloper\b|\bprogrammer\b|\bsoftware\b|\bwebdev\b": [
        "#Coding", "#Programming", "#Tech", "#Developer", "#WebDev"
    ],
    r"\bai\b|\bartificial\s*intelligence\b|\bchatgpt\b|\bgpt\b|\bdeepseek\b|\bllm\b|\bmachine\s*learning\b": [
        "#AI", "#ArtificialIntelligence", "#ChatGPT", "#TechNews"
    ],
    # Finance & Crypto
    r"\bbitcoin\b|\bcrypto\b|\beth\b|\bethereum\b|\bblockchain\b|\btoken\b": [
        "#Crypto", "#Bitcoin", "#Ethereum", "#Cryptocurrency"
    ],
    r"\bstocks\b|\bstock\s*market\b|\btrading\b|\binvesting\b|\bfinance\b|\bshare\s*market\b|\bnifty\b": [
        "#StockMarket", "#Trading", "#Investing", "#Finance", "#MoneyTips"
    ],
    # Fitness & Health
    r"\bgym\b|\bworkout\b|\bfitness\b|\bbodybuilding\b|\bmuscle\b|\bweight\s*loss\b|\bcalorie\b": [
        "#Fitness", "#Gym", "#Workout", "#Bodybuilding", "#FitnessMotivation"
    ],
    # Comedy, Roast & Memes
    r"\broast\b|\bcomedy\b|\bfunny\b|\blol\b|\blmao\b|\bprank\b|\bmeme\b|\bmemes\b": [
        "#Comedy", "#Funny", "#Roast", "#Memes", "#Entertainment"
    ],
    # Podcast & Talk
    r"\bpodcast\b|\binterview\b|\bconversation\b|\btalkshow\b": [
        "#Podcast", "#PodcastClips", "#Interview", "#StoryTime"
    ],
    # Cricket / Sports
    r"\bcricket\b|\bipl\b|\bviraat\b|\bkohli\b|\brohit\b|\bdhoni\b|\bind\s*vs\b": [
        "#Cricket", "#IPL", "#TeamIndia", "#CricketShots"
    ],
    r"\bfootball\b|\bsoccer\b|\bmessi\b|\bronaldo\b|\bchampions\s*league\b": [
        "#Football", "#Soccer", "#Ronaldo", "#Messi"
    ],
}


def generate_niche_hashtags(
    video_title: str = "",
    clip_title: str = "",
    transcript: str = "",
    limit: int = 7
) -> List[str]:
    """Detects specific games, creators, and niche topics from titles and content.
    Returns 4-7 specific, high-engagement hashtags."""
    # Replace underscores and special characters with spaces so word boundaries match properly
    combined = re.sub(r'[_+]+', ' ', f"{video_title} {clip_title} {transcript}").lower()
    selected_tags: List[str] = []
    seen: Set[str] = set()

    def add_tag(t: str):
        t_clean = t.strip()
        if not t_clean.startswith("#"):
            t_clean = f"#{t_clean}"
        canonical = t_clean.lower()
        if canonical not in seen and len(t_clean) > 2:
            seen.add(canonical)
            selected_tags.append(t_clean)

    is_gaming = False

    # 1. Match game keywords first (highest priority)
    for pattern, tags in GAME_KEYWORD_MAP.items():
        if re.search(pattern, combined):
            is_gaming = True
            for t in tags:
                add_tag(t)

    # 2. Match creator keywords
    for pattern, tags in CREATOR_KEYWORD_MAP.items():
        if re.search(pattern, combined):
            for t in tags:
                add_tag(t)

    # 3. Specific programming languages / frameworks
    for tech in ["python", "javascript", "typescript", "react", "nextjs", "fastapi", "docker", "flutter", "golang", "rust"]:
        if re.search(rf"\b{tech}\b", combined):
            add_tag(f"#{tech.capitalize()}")

    # 4. Match niche keywords
    for pattern, tags in NICHE_KEYWORD_MAP.items():
        if re.search(pattern, combined):
            for t in tags:
                add_tag(t)

    # 5. If gaming or gameplay detected, append category tags
    if is_gaming or "gameplay" in combined or "gamer" in combined or "game" in combined:
        add_tag("#Gaming")
        add_tag("#Gamer")

    # 6. Core discovery tags
    add_tag("#Shorts")
    add_tag("#Viral")
    add_tag("#Trending")

    return selected_tags[:limit]


def enrich_clip_metadata(clip: Dict[str, Any], video_title: str = "") -> Dict[str, Any]:
    """Ensures clip has specific niche hashtags populated in tags and descriptions."""
    existing_tags = list(clip.get("tags") or [])
    clip_title = clip.get("video_title_for_youtube_short") or clip.get("title") or ""
    tt_desc = clip.get("video_description_for_tiktok") or ""
    ig_desc = clip.get("video_description_for_instagram") or ""

    # Extract existing hashtags from descriptions
    desc_tags = re.findall(r"#[a-zA-Z0-9_]+", f"{tt_desc} {ig_desc}")

    # Generate niche-specific hashtags from titles and content
    generated = generate_niche_hashtags(video_title, clip_title, f"{tt_desc} {ig_desc}")

    # Combine unique tags maintaining priority order
    final_tags = []
    seen = set()
    for t in existing_tags + desc_tags + generated:
        canonical = t.lower()
        if canonical not in seen:
            seen.add(canonical)
            final_tags.append(t if t.startswith("#") else f"#{t}")

    clip["tags"] = final_tags[:7]
    tag_str = " ".join(clip["tags"])

    # Ensure descriptions end with these specific tags
    if not desc_tags and tag_str:
        if tt_desc:
            clip["video_description_for_tiktok"] = f"{tt_desc} {tag_str}".strip()
        else:
            clip["video_description_for_tiktok"] = f"{clip_title} {tag_str}".strip()

        if ig_desc:
            clip["video_description_for_instagram"] = f"{ig_desc} {tag_str}".strip()
        else:
            clip["video_description_for_instagram"] = f"{clip_title} {tag_str}".strip()

    return clip
