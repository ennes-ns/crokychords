//! Pure drawing from `App` + `PlayView`: header, chord grid, next-chord panel, MIDI panel and
//! footer. No I/O here, so `TestBackend` render tests cover the whole screen.

use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::Frame;

use crate::app::{App, PlayView};

const ACCENT: Color = Color::Green;
const DIM: Color = Color::DarkGray;
const ERROR: Color = Color::Red;

fn fmt_beats(b: f64) -> String {
    if b.fract() == 0.0 {
        format!("{b:.0}")
    } else {
        format!("{b}")
    }
}

pub fn render(f: &mut Frame, app: &App, play: &PlayView) {
    let grid_rows = grid_lines(app, play, f.area().width.saturating_sub(2)).len() as u16;
    let [header, grid, bottom, footer] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(grid_rows.max(2) + 2),
        Constraint::Min(6),
        Constraint::Length(2),
    ])
    .areas(f.area());
    render_header(f, header, app);
    let lines = grid_lines(app, play, grid.width.saturating_sub(2));
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(DIM))
        .title(" Progression ");
    f.render_widget(Paragraph::new(lines).block(block), grid);
    let [left, right] =
        Layout::horizontal([Constraint::Min(40), Constraint::Length(34)]).areas(bottom);
    render_suggestions(f, left, app);
    render_midi(f, right, app, play);
    render_footer(f, footer, app);
}

fn render_header(f: &mut Frame, area: Rect, app: &App) {
    let s = &app.song;
    let line = Line::from(vec![
        Span::styled(
            " Croky Chords ",
            Style::default().fg(Color::Black).bg(ACCENT),
        ),
        Span::raw(format!(
            "  {} · {} {} · {} BPM · {}/{} · {} chords · {} beats",
            s.title,
            s.key.tonic,
            s.key.mode.name(),
            fmt_beats(s.tempo),
            s.meter.beats,
            s.meter.unit,
            s.chords.len(),
            fmt_beats(s.total_beats()),
        )),
    ]);
    f.render_widget(Paragraph::new(line), area);
}

/// The grid: one cell per chord, 3 columns per beat (min 9), wrapped to the width; each row
/// of cells is two text lines (token, chord name). `›` marks the cursor, `♪` the playing chord.
pub fn grid_lines(app: &App, play: &PlayView, width: u16) -> Vec<Line<'static>> {
    if app.song.chords.is_empty() {
        return vec![Line::styled(
            " (empty: press Enter to start with the most common chord)",
            Style::default().fg(DIM),
        )];
    }
    let width = usize::from(width);
    let mut rows: Vec<(Vec<Span<'static>>, Vec<Span<'static>>)> = vec![(vec![], vec![])];
    let mut used = 0;
    for (i, c) in app.song.chords.iter().enumerate() {
        let w = ((c.beats * 3.0).round() as usize).clamp(9, 36);
        if used > 0 && used + w > width {
            rows.push((vec![], vec![]));
            used = 0;
        }
        used += w;
        let marker = if play.playing && play.chord == i {
            "♪"
        } else if i == app.cursor {
            "›"
        } else {
            " "
        };
        let mut style = Style::default();
        if i == app.cursor {
            style = style
                .fg(ACCENT)
                .add_modifier(Modifier::BOLD | Modifier::REVERSED);
        } else if play.playing && play.chord == i {
            style = style.fg(ACCENT);
        }
        let top = fit(&format!("{marker}{}", c.token), w - 1);
        let bottom = fit(&format!(" {}", app.name(&c.token)), w - 1);
        if let Some(row) = rows.last_mut() {
            row.0.push(Span::styled(top, style));
            row.0.push(Span::styled("│", Style::default().fg(DIM)));
            row.1.push(Span::styled(
                bottom,
                style
                    .remove_modifier(Modifier::BOLD)
                    .fg(if i == app.cursor { ACCENT } else { DIM }),
            ));
            row.1.push(Span::styled("│", Style::default().fg(DIM)));
        }
    }
    rows.into_iter()
        .flat_map(|(a, b)| [Line::from(a), Line::from(b)])
        .collect()
}

/// Pad or cut to exactly `w` display columns.
fn fit(s: &str, w: usize) -> String {
    let mut out: String = s.chars().take(w).collect();
    let n = out.chars().count();
    out.extend(std::iter::repeat_n(' ', w - n));
    out
}

fn render_suggestions(f: &mut Frame, area: Rect, app: &App) {
    let context = app.context();
    let used = app
        .suggestions
        .first()
        .map(|s| s.context_used.join(" "))
        .unwrap_or_default();
    let title = if context.is_empty() {
        " Next chord (song start) ".to_string()
    } else {
        format!(
            " Next chord after {} ",
            context.last().map_or("", String::as_str)
        )
    };
    let mut lines: Vec<Line> = Vec::new();
    let top = app
        .suggestions
        .first()
        .map_or(1.0, |s| s.probability)
        .max(1e-9);
    let bar_width = usize::from(area.width.saturating_sub(34)).min(30);
    for (n, s) in app.suggestions.iter().enumerate() {
        let filled = ((s.probability / top) * bar_width as f64).round() as usize;
        let style = if n == 0 {
            Style::default().fg(ACCENT)
        } else {
            Style::default()
        };
        lines.push(Line::from(vec![
            Span::styled(format!(" {} ", n + 1), Style::default().fg(DIM)),
            Span::styled(fit(&s.token, 9), style.add_modifier(Modifier::BOLD)),
            Span::styled(fit(&app.name(&s.token), 9), style),
            Span::styled(format!("{:>5.1}% ", s.probability * 100.0), style),
            Span::styled("█".repeat(filled), style),
        ]));
    }
    if app.suggestions.is_empty() {
        lines.push(Line::styled(
            " no suggestions for this mode in the table",
            Style::default().fg(DIM),
        ));
    }
    lines.push(Line::styled(
        format!(
            " matched context: {}",
            if used.is_empty() {
                "(none, unigram)".to_string()
            } else {
                used
            }
        ),
        Style::default().fg(DIM),
    ));
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(DIM))
        .title(title);
    f.render_widget(Paragraph::new(lines).block(block), area);
}

fn render_midi(f: &mut Frame, area: Rect, app: &App, play: &PlayView) {
    let dim = Style::default().fg(DIM);
    let mut lines = vec![];
    match &play.port {
        Some(port) => lines.push(Line::from(vec![
            Span::styled(" out  ", dim),
            Span::raw(port.clone()),
        ])),
        None => lines.push(Line::styled(" out  none", Style::default().fg(ERROR))),
    }
    let state = if play.playing {
        Span::styled("● playing", Style::default().fg(ACCENT))
    } else {
        Span::styled("○ stopped", dim)
    };
    lines.push(Line::from(vec![Span::styled(" now  ", dim), state]));
    lines.push(Line::from(vec![
        Span::styled(" loop ", dim),
        Span::raw(if app.looped { "on" } else { "off" }),
    ]));
    lines.push(Line::from(vec![
        Span::styled(" late ", dim),
        Span::raw(if play.sent == 0 {
            "–".to_string()
        } else {
            format!(
                "max {:.2} ms over {} msgs",
                play.max_late_us as f64 / 1000.0,
                play.sent
            )
        }),
    ]));
    lines.push(Line::from(vec![
        Span::styled(" data ", dim),
        Span::raw(app.table_name.clone()),
    ]));
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(dim)
        .title(" MIDI ");
    f.render_widget(Paragraph::new(lines).block(block), area);
}

fn render_footer(f: &mut Frame, area: Rect, app: &App) {
    let dim = Style::default().fg(DIM);
    let keys = Line::styled(
        " ←/→ move  Enter insert top  1-8 insert nth  x delete  Space play/stop  r loop  w save  q quit",
        dim,
    );
    let status = match &app.error {
        Some(e) => Line::styled(format!(" {e}"), Style::default().fg(ERROR)),
        None if app.status.is_empty() => Line::styled(
            " q stops playback and exits; the song is only written with w",
            dim,
        ),
        None => Line::raw(format!(" {}", app.status)),
    };
    f.render_widget(Paragraph::new(vec![keys, status]), area);
}
