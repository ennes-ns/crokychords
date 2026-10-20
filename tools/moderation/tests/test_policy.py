"""The decision function on fixture score vectors (docs/specs/moderation-v1.md §1)."""

from __future__ import annotations

import math

from crokychords_moderation.policy import GuardResult, Measurements, Policy, decide


def clean(**overrides: object) -> Measurements:
    """A plain, fine vocal one-shot: every check ran, nothing near a threshold."""
    m = Measurements(
        name="Vocal ah",
        tags=["vocal", "one-shot"],
        duration_s=0.8,
        peak_dbfs=-6.0,
        true_peak_dbtp=-5.8,
        clipped_ratio=0.0,
        integrated_lufs=-18.0,
        transcript="",
        vad_ratio=0.1,
        events={"Speech": 0.2, "Screaming": 0.01},
        guard=GuardResult(safe=True),
    )
    for key, value in overrides.items():
        setattr(m, key, value)
    return m


def test_clean_one_shot_is_ok(policy: Policy) -> None:
    v = decide(clean(), policy)
    assert v.verdict == "ok"
    assert v.category is None
    assert v.label == "ok"
    assert v.reasons == []
    assert v.notes == []
    assert v.scores["Speech"] == 0.2


def test_undecodable_and_empty(policy: Policy) -> None:
    v = decide(clean(decode_error="no audio stream"), policy)
    assert v.label == "flag:quality"
    assert "could not be decoded" in v.reasons[0]
    assert decide(clean(duration_s=0.0), policy).label == "flag:quality"


def test_too_long(policy: Policy) -> None:
    assert decide(clean(duration_s=30.0), policy).verdict == "ok"
    v = decide(clean(duration_s=30.5), policy)
    assert v.label == "flag:quality"
    assert "longer than 30 s" in v.reasons[0]


def test_silence(policy: Policy) -> None:
    assert decide(clean(peak_dbfs=-math.inf), policy).label == "flag:quality"
    assert decide(clean(peak_dbfs=-61.0), policy).label == "flag:quality"
    quiet = decide(clean(peak_dbfs=-50.0), policy)
    assert quiet.verdict == "ok"
    assert quiet.notes == ["quality: very quiet: peak -50.0 dBFS"]
    assert decide(clean(peak_dbfs=-44.0), policy).notes == []


def test_sustained_clipping_needs_both(policy: Policy) -> None:
    v = decide(clean(true_peak_dbtp=1.5, clipped_ratio=0.002), policy)
    assert v.label == "flag:loudness"
    assert "sustained clipping" in v.reasons[0]
    over = decide(clean(true_peak_dbtp=0.5, clipped_ratio=0.0005), policy)
    assert over.verdict == "ok"
    assert over.notes[0].startswith("loudness: true peak")
    assert decide(clean(true_peak_dbtp=-0.1, clipped_ratio=0.5), policy).verdict == "ok"


def test_ear_damaging_loudness(policy: Policy) -> None:
    assert decide(clean(integrated_lufs=-4.0), policy).label == "flag:loudness"
    loud = decide(clean(integrated_lufs=-7.0), policy)
    assert loud.verdict == "ok"
    assert loud.notes == ["loudness: very loud: -7.0 LUFS"]
    assert decide(clean(integrated_lufs=-9.0), policy).notes == []
    assert decide(clean(integrated_lufs=None), policy).verdict == "ok"


def test_allow_listed_syllables_are_not_speech(policy: Policy) -> None:
    for transcript in ("Ah!", "Oh yeah.", "Heyyyy", "mmm", "Ooooh", "uh-huh", "Hey, hey!"):
        v = decide(clean(transcript=transcript, vad_ratio=0.2), policy)
        assert v.verdict == "ok", transcript


def test_one_real_word_is_speech(policy: Policy) -> None:
    v = decide(clean(transcript="Hello."), policy)
    assert v.label == "flag:speech"
    assert v.reasons == ["speech: words heard: “hello”"]
    assert v.scores["words_outside_allow"] == 1.0


def test_sentence_is_speech(policy: Policy) -> None:
    v = decide(clean(transcript="Please call me back tomorrow morning.", vad_ratio=0.9), policy)
    assert v.label == "flag:speech"
    assert len(v.reasons) == 2
    assert "…" in v.reasons[0] or "morning" in v.reasons[0]
    assert v.reasons[1] == "speech: speech covers 90 % of the sample"


def test_single_characters_are_not_words(policy: Policy) -> None:
    assert decide(clean(transcript="Q."), policy).verdict == "ok"


def test_vad_rule_needs_enough_words(policy: Policy) -> None:
    chant = decide(clean(transcript="hey hey hey hey", vad_ratio=0.8), policy)
    assert chant.label == "flag:speech"
    assert chant.reasons == ["speech: speech covers 80 % of the sample"]
    short = decide(clean(transcript="oh yeah", vad_ratio=0.8), policy)
    assert short.verdict == "ok"
    assert short.notes == ["speech: speech covers 80 % of the sample"]
    assert decide(clean(transcript="", vad_ratio=0.9), policy).notes == []
    assert decide(clean(transcript="hey hey hey", vad_ratio=0.2), policy).notes == []


def test_screaming_thresholds(policy: Policy) -> None:
    flagged = decide(clean(events={"Screaming": 0.35}), policy)
    assert flagged.label == "flag:violence"
    assert flagged.reasons == ["violence: screaming: Screaming 0.35"]
    borderline = decide(clean(events={"Screaming": 0.2}), policy)
    assert borderline.verdict == "ok"
    assert borderline.notes == ["violence: screaming: Screaming 0.20"]
    assert decide(clean(events={"Screaming": 0.1}), policy).notes == []


def test_shout_needs_a_high_score(policy: Policy) -> None:
    assert decide(clean(events={"Shout": 0.6}), policy).verdict == "ok"
    assert decide(clean(events={"Yell": 0.71}), policy).label == "flag:violence"


def test_gunshot_and_explosion(policy: Policy) -> None:
    assert decide(clean(events={"Gunshot, gunfire": 0.5}), policy).label == "flag:violence"
    assert decide(clean(events={"Machine gun": 0.45}), policy).label == "flag:violence"
    assert decide(clean(events={"Explosion": 0.5}), policy).verdict == "ok"
    assert decide(clean(events={"Explosion": 0.65}), policy).label == "flag:violence"
    # Boom fires on 808 kicks; it is not a policy class.
    assert decide(clean(events={"Boom": 0.99}), policy).notes == []


def test_moaning_is_sexual(policy: Policy) -> None:
    assert decide(clean(events={"Wail, moan": 0.4}), policy).label == "flag:sexual"
    assert decide(clean(events={"Groan": 0.36}), policy).label == "flag:sexual"
    breath = decide(clean(events={"Pant": 0.9}), policy)
    assert breath.verdict == "ok"
    assert breath.notes == ["sexual: heavy breathing: Pant 0.90"]


def test_event_speech_classes_are_notes_only(policy: Policy) -> None:
    v = decide(clean(events={"Speech": 0.95, "Narration, monologue": 0.7}), policy)
    assert v.verdict == "ok"
    assert v.notes == ["speech: speech-like sound: Speech 0.95"]


def test_category_order_and_all_reasons(policy: Policy) -> None:
    v = decide(
        clean(
            transcript="kill them all",
            vad_ratio=0.9,
            events={"Screaming": 0.6, "Wail, moan": 0.5},
            integrated_lufs=-3.0,
        ),
        policy,
    )
    assert v.label == "flag:sexual"
    categories = [r.split(":")[0] for r in v.reasons]
    assert categories == ["sexual", "violence", "speech", "speech", "loudness"]


def test_text_rules(policy: Policy) -> None:
    assert decide(clean(name="Heil kick"), policy).label == "flag:hate"
    assert decide(clean(tags=["n4zi"]), policy).label == "flag:hate"
    assert decide(clean(name="mail me at someone@example.com"), policy).label == "flag:personal"
    assert decide(clean(name="Kick 808", tags=["drums", "kick"]), policy).verdict == "ok"


def test_guard_mapping(policy: Policy) -> None:
    assert decide(clean(guard=GuardResult(safe=False, categories=["S12"])), policy).label == "flag:sexual"
    assert decide(clean(guard=GuardResult(safe=False, categories=["S10"])), policy).label == "flag:hate"
    assert decide(clean(guard=GuardResult(safe=False, categories=["s1"])), policy).label == "flag:violence"
    other = decide(clean(guard=GuardResult(safe=False, categories=["S6"])), policy)
    assert other.verdict == "ok"
    assert other.notes == ["other: text model: name or tags unsafe (S6)"]
    missing = decide(clean(guard=None), policy)
    assert missing.verdict == "ok"
    assert "text model unavailable" in missing.notes[0]


def test_checks_that_did_not_run_do_not_apply(policy: Policy) -> None:
    v = decide(clean(transcript=None, vad_ratio=None, events=None), policy)
    assert v.verdict == "ok"
    assert "Screaming" not in v.scores
    assert "words" not in v.scores


def test_reasons_are_bounded(policy: Policy) -> None:
    v = decide(clean(transcript=" ".join(["word"] * 500), name="x" * 400), policy)
    assert all(len(r) <= 200 for r in v.reasons + v.notes)
    assert len(v.reasons) <= 20
