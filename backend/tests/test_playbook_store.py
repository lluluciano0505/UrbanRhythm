"""Tests for M03 — Playbook Store. Uses in-memory SQLite via M11."""

import pytest

import data.database as db
import data.playbook_store as ps


# ── Fixtures ──────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def fresh_db():
    db.init_db(":memory:")


# ── get() — exact domain match ────────────────────────────────────────────────


def test_get_returns_none_for_unknown_domain():
    result = ps.get("unknown.com")
    assert result is None


def test_get_returns_none_when_only_failures_recorded():
    ps.save("example.com", None, {}, success=False)
    assert ps.get("example.com") is None


def test_get_returns_strategy_after_successful_save():
    ps.save("example.com", "json_ld", {"path": "/events"}, success=True)
    result = ps.get("example.com")
    assert result is not None
    assert result.strategy == "json_ld"
    assert result.detail == {"path": "/events"}


def test_get_returns_correct_strategy_type():
    ps.save("lib.org", "ical", {"ical_path": "/calendar.ics"}, success=True)
    result = ps.get("lib.org")
    assert isinstance(result, ps.Strategy)
    assert result.strategy == "ical"
    assert result.detail["ical_path"] == "/calendar.ics"


def test_get_includes_cms_type():
    ps.save("museum.org", "json_ld", {}, success=True, cms_type="squarespace")
    result = ps.get("museum.org")
    assert result.cms_type == "squarespace"


def test_get_confidence_is_correct():
    # 2 successes, 1 failure → confidence = 2/3
    ps.save("example.com", "json_ld", {}, success=True)
    ps.save("example.com", "json_ld", {}, success=True)
    ps.save("example.com", None, {}, success=False)
    result = ps.get("example.com")
    assert result.confidence == pytest.approx(2 / 3)


def test_get_confidence_is_one_for_all_successes():
    ps.save("example.com", "json_ld", {}, success=True)
    ps.save("example.com", "json_ld", {}, success=True)
    result = ps.get("example.com")
    assert result.confidence == pytest.approx(1.0)


# ── save() ────────────────────────────────────────────────────────────────────


def test_save_increments_success_count():
    ps.save("example.com", "ical", {}, success=True)
    ps.save("example.com", "ical", {}, success=True)
    row = db.get_playbook("example.com")
    assert row["success_count"] == 2


def test_save_increments_failure_count():
    ps.save("example.com", None, {}, success=False)
    ps.save("example.com", None, {}, success=False)
    row = db.get_playbook("example.com")
    assert row["failure_count"] == 2


def test_save_failure_does_not_overwrite_good_strategy():
    ps.save("example.com", "navigate_html", {"path": "/events"}, success=True)
    ps.save("example.com", None, {}, success=False)
    row = db.get_playbook("example.com")
    assert row["strategy"] == "navigate_html"


def test_save_success_updates_strategy():
    ps.save("example.com", "navigate_html", {}, success=True)
    ps.save("example.com", "ical", {"path": "/feed.ics"}, success=True)
    row = db.get_playbook("example.com")
    # Most recent success strategy should win
    assert row["strategy"] == "ical"


def test_save_records_cms_type():
    ps.save("wp-site.org", "ical", {}, success=True, cms_type="wordpress")
    row = db.get_playbook("wp-site.org")
    assert row["cms_type"] == "wordpress"


def test_save_stores_complex_detail():
    detail = {"paths": ["/?ical=1", "/events/feed/"], "retries": 2}
    ps.save("complex.org", "ical", detail, success=True)
    result = ps.get("complex.org")
    assert result.detail == detail


# ── detect_cms() ──────────────────────────────────────────────────────────────


def test_detect_cms_wordpress_standard():
    html = '<meta name="generator" content="WordPress 6.4.2">'
    assert ps.detect_cms(html) == "wordpress"


def test_detect_cms_wordpress_reversed_attributes():
    html = '<meta content="WordPress 6.4" name="generator">'
    assert ps.detect_cms(html) == "wordpress"


def test_detect_cms_wordpress_case_insensitive():
    html = '<META NAME="Generator" CONTENT="WordPress 5.9">'
    assert ps.detect_cms(html) == "wordpress"


def test_detect_cms_squarespace():
    html = "var Squarespace = {}; Squarespace.SQUARESPACE_V6 = true;"
    assert ps.detect_cms(html) == "squarespace"


def test_detect_cms_drupal():
    html = "Drupal.settings = {}; Drupal.behaviors = {};"
    assert ps.detect_cms(html) == "drupal"


def test_detect_cms_webflow():
    html = '<div data-wf-site="abc123" data-wf-page="xyz">'
    assert ps.detect_cms(html) == "webflow"


def test_detect_cms_returns_none_for_unknown():
    html = "<html><body><p>Just a plain website.</p></body></html>"
    assert ps.detect_cms(html) is None


def test_detect_cms_checks_wordpress_first():
    # Edge case: page has both WordPress and Squarespace markers (shouldn't happen but let's be safe)
    html = '<meta name="generator" content="WordPress"> Squarespace.SQUARESPACE_V6 = true;'
    assert ps.detect_cms(html) == "wordpress"


# ── get_cms_defaults() ────────────────────────────────────────────────────────


def test_get_cms_defaults_wordpress():
    result = ps.get_cms_defaults("wordpress")
    assert result is not None
    assert result.strategy == "ical"
    assert "/?ical=1" in result.detail.get("paths", [])


def test_get_cms_defaults_squarespace():
    result = ps.get_cms_defaults("squarespace")
    assert result is not None
    assert result.strategy == "json_ld"


def test_get_cms_defaults_drupal():
    result = ps.get_cms_defaults("drupal")
    assert result is not None
    assert result.strategy == "navigate_html"
    assert result.detail.get("path") == "/events"


def test_get_cms_defaults_webflow():
    result = ps.get_cms_defaults("webflow")
    assert result is not None
    assert result.strategy == "json_ld"


def test_get_cms_defaults_unknown_returns_none():
    assert ps.get_cms_defaults("unknown_cms") is None


def test_get_cms_defaults_returns_strategy_instance():
    result = ps.get_cms_defaults("wordpress")
    assert isinstance(result, ps.Strategy)
    assert result.cms_type == "wordpress"


# ── Full lookup flow (integration) ───────────────────────────────────────────


def test_full_lookup_step1_domain_hit():
    """Domain match bypasses CMS detection entirely."""
    ps.save("bestlib.org", "json_ld", {"path": "/events"}, success=True)
    result = ps.get("bestlib.org")
    assert result is not None
    assert result.strategy == "json_ld"


def test_full_lookup_step2_cms_fallback():
    """When no domain record, CMS detection + defaults provide a strategy."""
    html = '<meta name="generator" content="WordPress 6.4">'
    cms = ps.detect_cms(html)
    strategy = ps.get_cms_defaults(cms)
    assert strategy is not None
    assert strategy.strategy == "ical"


def test_full_lookup_step3_no_record_no_cms():
    """When neither domain nor CMS is known, both return None — caller uses defaults."""
    domain_result = ps.get("mystery.org")
    html = "<html><body>Custom site</body></html>"
    cms = ps.detect_cms(html)
    assert domain_result is None
    assert cms is None
