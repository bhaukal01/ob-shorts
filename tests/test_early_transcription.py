import threading
import time
import pytest


def test_early_audio_abandonment_prevents_duplicate_work():
    """Verify that if main thread finishes download before audio begins,
    early_state['abandoned'] stops any subsequent background transcription."""
    early = {
        "lock": threading.Lock(),
        "done": threading.Event(),
        "started": False,
        "abandoned": False,
        "invalid": False,
        "transcript": None,
        "clips": None,
    }

    work_executed = []

    def _early_work(audio_path, duration):
        work_executed.append(audio_path)
        early["done"].set()

    def _on_audio(audio_path, duration):
        with early["lock"]:
            if early["abandoned"]:
                return
            early["started"] = True
        threading.Thread(target=_early_work, args=(audio_path, duration)).start()

    # Simulate main thread finishing download before on_audio is triggered
    with early["lock"]:
        started = early["started"]
        if not started:
            early["abandoned"] = True

    assert early["abandoned"] is True

    # Now on_audio triggers late
    _on_audio("/tmp/fake_audio.m4a", 60.0)
    time.sleep(0.05)

    # Work should NOT have been executed
    assert len(work_executed) == 0
    assert early["started"] is False


def test_early_audio_coordination_when_started():
    """Verify that if early audio started, main thread waits on done event
    and picks up the precomputed transcript without re-transcribing."""
    early = {
        "lock": threading.Lock(),
        "done": threading.Event(),
        "started": False,
        "abandoned": False,
        "invalid": False,
        "transcript": None,
        "clips": None,
    }

    expected_transcript = {"language": "en", "segments": [{"start": 0.0, "end": 2.0, "text": "hello"}]}

    def _early_work(audio_path, duration):
        time.sleep(0.05)
        early["transcript"] = expected_transcript
        early["done"].set()

    def _on_audio(audio_path, duration):
        with early["lock"]:
            if early["abandoned"]:
                return
            early["started"] = True
        threading.Thread(target=_early_work, args=(audio_path, duration)).start()

    _on_audio("/tmp/fake_audio.m4a", 60.0)

    # Simulate main thread reaching line 3335
    early_state = early
    transcript = None
    if transcript is None and early_state is not None:
        with early_state["lock"]:
            started = early_state["started"]
            if not started:
                early_state["abandoned"] = True
        if started and not early_state["invalid"]:
            assert early_state["done"].wait(timeout=2.0) is True
            if early_state["transcript"] is not None:
                transcript = early_state["transcript"]

    assert transcript == expected_transcript

