"""Unit tests for niche_tags.py hashtag engine."""
import unittest
import niche_tags


class TestNicheTags(unittest.TestCase):
    def test_gta6_gaming_hashtags(self):
        title = "🔴WELCOME_TO_GTA_6🌴FIRST_GTA_VI_GAMEPLAY🌴RACKATHON_2_🌴_DAY_4🌴_BIG_VILLA_🌴RACHITROO_Powered_by_1win"
        tags = niche_tags.generate_niche_hashtags(title)
        self.assertIn("#GTA6", tags)
        self.assertIn("#GTAVI", tags)
        self.assertIn("#GrandTheftAuto6", tags)
        self.assertIn("#GamingShorts", tags)

    def test_minecraft_gaming_hashtags(self):
        title = "Surviving 100 Days in Hardcore Minecraft Bedrock"
        tags = niche_tags.generate_niche_hashtags(title)
        self.assertIn("#Minecraft", tags)
        self.assertIn("#MinecraftShorts", tags)
        self.assertIn("#Gaming", tags)

    def test_coding_tech_hashtags(self):
        title = "How to build an AI agent in Python"
        tags = niche_tags.generate_niche_hashtags(title)
        self.assertIn("#Python", tags)
        self.assertIn("#Coding", tags)
        self.assertIn("#AI", tags)

    def test_finance_crypto_hashtags(self):
        title = "Bitcoin hits 100k: Best crypto investing strategy"
        tags = niche_tags.generate_niche_hashtags(title)
        self.assertIn("#Crypto", tags)
        self.assertIn("#Bitcoin", tags)
        self.assertIn("#Investing", tags)

    def test_enrich_clip_metadata(self):
        clip = {
            "video_title_for_youtube_short": "Crazy GTA stunt",
            "video_description_for_tiktok": "Look at this jump!",
            "video_description_for_instagram": "Look at this jump!",
        }
        res = niche_tags.enrich_clip_metadata(clip, "GTA 6 Gameplay Live")
        self.assertTrue(len(res["tags"]) >= 4)
        self.assertIn("#GTA6", res["tags"])
        self.assertIn("#GTA6", res["video_description_for_tiktok"])
        self.assertIn("#GTA6", res["video_description_for_instagram"])


if __name__ == "__main__":
    unittest.main()
