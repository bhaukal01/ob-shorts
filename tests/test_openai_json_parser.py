import pytest
import gemini_worker
from pydantic import BaseModel
from typing import List


def test_parse_pure_json():
    text = '{"windows": [{"id": "w0", "score": 90}]}'
    res = gemini_worker._parse_json_response_text(text, provider_name="OpenAI API")
    assert res == {"windows": [{"id": "w0", "score": 90}]}


def test_parse_markdown_fence():
    text = '```json\n{"windows": [{"id": "w1", "score": 80}]}\n```'
    res = gemini_worker._parse_json_response_text(text, provider_name="OpenAI API")
    assert res == {"windows": [{"id": "w1", "score": 80}]}


def test_parse_preamble_and_trailing_notes_with_extra_braces():
    # Regression test for: Failed to parse Gemini JSON response: Extra data: line 1 column 154 (char 153)
    text = (
        'Here is your JSON output:\n'
        '```json\n'
        '{"windows": [{"id": "w2", "score": 75}]}\n'
        '```\n'
        'Note: I evaluated {5} candidate windows in total.'
    )
    res = gemini_worker._parse_json_response_text(text, provider_name="OpenAI API")
    assert res == {"windows": [{"id": "w2", "score": 75}]}


def test_parse_thinking_tags_stripped():
    text = (
        '<think>\n'
        'Let me analyze the windows. {window_0} seems weak, but window_1 is great.\n'
        '</think>\n'
        '{"windows": [{"id": "w3", "score": 85}]}'
    )
    res = gemini_worker._parse_json_response_text(text, provider_name="OpenAI API")
    assert res == {"windows": [{"id": "w3", "score": 85}]}


def test_parse_empty_body_raises_with_provider_name():
    with pytest.raises(ValueError) as excinfo:
        gemini_worker._parse_json_response_text("", provider_name="OpenAI API")
    assert "OpenAI API returned an empty response body" in str(excinfo.value)


def test_parse_thinking_only_body_raises():
    with pytest.raises(ValueError) as excinfo:
        gemini_worker._parse_json_response_text("<think>Thinking only...</think>", provider_name="OpenAI API")
    assert "OpenAI API response contained no content outside thinking tags" in str(excinfo.value)


def test_parse_invalid_json_names_provider():
    with pytest.raises(ValueError) as excinfo:
        gemini_worker._parse_json_response_text("This is plain text with no json at all.", provider_name="OpenAI API")
    assert "Failed to parse OpenAI API JSON response" in str(excinfo.value)
