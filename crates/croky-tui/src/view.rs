//! Pure drawing from `App` + `PlayView`: header, the progression grid (bar positions and the
//! loop range above each chord, the "+" slot at the end), the Next chord panel, the band panel,
//! the MIDI panel and the footer, plus the help, saves and rename overlays. No I/O here, so
//! `TestBackend` render tests cover every screen.

use croky_core::json::js_number;
use ratatui::layout::{Constraint, Flex, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};
use ratatui::Frame;

use crate::app::{mode_label, App, PlayView, SavesView, Screen};
use crate::edit::{bar_length, insert_length, position_label, DEFAULT_INSERT_BEATS};
use crate::keys::HELP;

const ACCENT: Color = Color::Green;
const DIM: Color = Color::DarkGray;
const ERROR: Color = Color::Red;
const LOOP: Color = Color::Yellow;
/// Columns per beat in the grid, and the narrowest and widest chord cell.
const BEAT_COLS: f64 = 3.0;
const CELL_MIN: usize = 9;
const CELL_MAX: usize = 36;

fn dim() -> Style {
    Style::default().fg(DIM)
}

fn panel(title: impl Into<String>) -> Block<'static> {
    Block::default()
        .borders(Borders::ALL)
        .border_style(dim())
        .title(title.into())
}

/// Pad or cut to exactly `w` display columns.
fn fit(s: &str, w: usize) -> String {
    let mut out: String = s.chars().take(w).collect();
    let n = out.chars().count();
    out.extend(std::iter::repeat_n(' ', w - n));
    out
}

pub fn render(f: &mut Frame, app: &App, play: &PlayView) {
    let area = f.area();
    let grid = grid_lines(app, play, area.width.saturating_sub(2));
    let [header, grid_area, bottom, footer] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(grid.len().max(3) as u16 + 2),
        Constraint::Min(8),
        Constraint::Length(2),
    ])
    .areas(area);
    render_header(f, header, app);
    f.render_widget(
        Paragraph::new(grid).block(panel(" Progression ")),
        grid_area,
    );
    let [left, right] =
        Layout::horizontal([Constraint::Min(40), Constraint::Length(38)]).areas(bottom);
    render_suggestions(f, left, app);
    let band_rows = app.song.tracks.as_ref().map_or(0, Vec::len) as u16 + 1;
    let [band, midi] =
        Layout::vertical([Constraint::Length(band_rows + 2), Constraint::Min(5)]).areas(right);
    render_band(f, band, app);
    render_midi(f, midi, app, play);
    render_footer(f, footer, app);
    match &app.screen {
        Screen::Editor => {}
        Screen::Help => render_help(f, area),
        Screen::Rename(text) => render_rename(f, area, text),
        Screen::Saves(view) => render_saves(f, area, view),
    }
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
            mode_label(s.key.mode),
            js_number(s.tempo),
            s.meter.beats,
            s.meter.unit,
            s.chords.len(),
            js_number(s.total_beats()),
        )),
        Span::styled(format!("  {}", app.save_label), dim()),
    ]);
    f.render_widget(Paragraph::new(line), area);
}

fn cell_width(beats: f64) -> usize {
    ((beats * BEAT_COLS).round() as usize).clamp(CELL_MIN, CELL_MAX)
}

/// The grid: one cell per chord (3 columns per beat, 9 to 36 wide) plus the "+" slot, wrapped
/// to the width. Each row of cells is three lines: the bar position with the loop range (`━`
/// looping, `╌` off), the token with `›` for the selection and `♪` for the playing chord, and
/// the chord name.
pub fn grid_lines(app: &App, play: &PlayView, width: u16) -> Vec<Line<'static>> {
    let song = &app.song;
    let width = usize::from(width).max(CELL_MIN);
    let bar = bar_length(song);
    let playing = play
        .position
        .filter(|_| play.playing)
        .and_then(|beat| song.chord_at_beat(beat))
        .map(|at| at.index);
    let range = app.loop_range;
    let loop_style = Style::default().fg(LOOP);

    type Row = [Vec<Span<'static>>; 3];
    let mut rows: Vec<Row> = vec![Default::default()];
    let mut used = 0;
    let mut push = |rows: &mut Vec<Row>, w: usize, cell: [Span<'static>; 3]| {
        if used > 0 && used + w > width {
            rows.push(Default::default());
            used = 0;
        }
        used += w;
        if let Some(row) = rows.last_mut() {
            for (line, span) in row.iter_mut().zip(cell) {
                line.push(span);
            }
        }
    };

    let mut start = 0.0;
    for (i, c) in song.chords.iter().enumerate() {
        let w = cell_width(c.beats);
        let end = start + c.beats;
        let selected = app.selected == Some(i);
        let marker = if playing == Some(i) {
            "♪"
        } else if selected {
            "›"
        } else {
            " "
        };
        let mut style = Style::default();
        if selected {
            style = style
                .fg(ACCENT)
                .add_modifier(Modifier::BOLD | Modifier::REVERSED);
        } else if playing == Some(i) {
            style = style.fg(ACCENT);
        }
        let in_loop = range.is_some_and(|r| start >= r.start - 1e-9 && end <= r.end + 1e-9);
        let fill = match (in_loop, app.looping) {
            (true, true) => '━',
            (true, false) => '╌',
            _ => ' ',
        };
        let label = position_label(start, bar);
        let label = label.strip_suffix(".1").unwrap_or(&label);
        let mut ruler = format!(" {label} ");
        while ruler.chars().count() < w {
            ruler.push(fill);
        }
        let name_style =
            style
                .remove_modifier(Modifier::BOLD)
                .fg(if selected { ACCENT } else { DIM });
        push(
            &mut rows,
            w,
            [
                Span::styled(fit(&ruler, w), if in_loop { loop_style } else { dim() }),
                Span::styled(fit(&format!("{marker}{}", c.token), w - 1) + "│", style),
                Span::styled(
                    fit(&format!(" {}", app.name(&c.token)), w - 1) + "│",
                    name_style,
                ),
            ],
        );
        start = end;
    }
    // The "+" slot: as wide as the chord a pick would add there.
    let next = song.chords.last().map_or_else(
        || insert_length(song, 0.0, DEFAULT_INSERT_BEATS),
        |c| c.beats,
    );
    let w = cell_width(next);
    let selected = app.selected.is_none();
    let style = if selected {
        Style::default()
            .fg(ACCENT)
            .add_modifier(Modifier::BOLD | Modifier::REVERSED)
    } else {
        dim()
    };
    push(
        &mut rows,
        w,
        [
            Span::styled(fit("", w), dim()),
            Span::styled(fit(if selected { "›+" } else { " +" }, w - 1) + "┊", style),
            Span::styled(
                fit(" add", w - 1) + "┊",
                style.remove_modifier(Modifier::BOLD),
            ),
        ],
    );
    rows.into_iter()
        .flat_map(|[a, b, c]| [Line::from(a), Line::from(b), Line::from(c)])
        .collect()
}

fn render_suggestions(f: &mut Frame, area: Rect, app: &App) {
    let count = app.song.chords.len();
    let title = match app.selected.filter(|&i| i < count) {
        Some(i) => format!(
            " Next chord · replaces chord {} ({}) ",
            i + 1,
            app.song.chords[i].token
        ),
        None => " Next chord · adds at the end ".to_string(),
    };
    let title = if app.diatonic_only {
        format!("{title}· diatonic only ")
    } else {
        title
    };
    let inner_rows = usize::from(area.height.saturating_sub(2));
    let room = inner_rows.saturating_sub(2).max(1);
    let top = app
        .suggestions
        .first()
        .map_or(1.0, |s| s.probability)
        .max(1e-9);
    let bar_width = usize::from(area.width.saturating_sub(32)).min(30);
    // Keep the highlighted row in view.
    let first = app.highlight.saturating_sub(room.saturating_sub(1));
    let mut lines: Vec<Line> = Vec::new();
    for (n, s) in app.suggestions.iter().enumerate().skip(first).take(room) {
        let filled = ((s.probability / top) * bar_width as f64).round() as usize;
        let chosen = n == app.highlight;
        let style = if chosen {
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)
        } else {
            Style::default()
        };
        lines.push(Line::from(vec![
            Span::styled(if chosen { " ▸ " } else { "   " }, style),
            Span::styled(fit(&s.token, 9), style),
            Span::styled(fit(&app.name(&s.token), 9), style),
            Span::styled(format!("{:>5.1}% ", s.probability * 100.0), style),
            Span::styled("█".repeat(filled), if chosen { style } else { dim() }),
        ]));
    }
    if app.suggestions.is_empty() {
        lines.push(Line::styled(
            "   no suggestions for this mode in the table",
            dim(),
        ));
    }
    let used = app
        .suggestions
        .first()
        .map(|s| s.context_used.join(" "))
        .unwrap_or_default();
    lines.push(Line::styled(
        format!(
            "   after: {}",
            if used.is_empty() {
                "any position".to_string()
            } else {
                used
            }
        ),
        dim(),
    ));
    let action = if app.selected.is_some_and(|i| i < count) {
        "Enter replaces · S-Enter inserts after"
    } else {
        "Enter adds"
    };
    lines.push(Line::styled(format!("   ↑/↓ choose · {action}"), dim()));
    f.render_widget(Paragraph::new(lines).block(panel(title)), area);
}

fn render_band(f: &mut Frame, area: Rect, app: &App) {
    let mut lines = Vec::new();
    let row = |selected: bool, name: &str, what: &str, ch: i32, muted: bool| {
        let style = if selected {
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)
        } else if muted {
            dim()
        } else {
            Style::default()
        };
        Line::from(vec![
            Span::styled(if selected { " ▸ " } else { "   " }, style),
            Span::styled(fit(name, 8), style),
            Span::styled(fit(what, 14), style),
            Span::styled(fit(&format!("ch{}", ch + 1), 5), style),
            Span::styled(if muted { "muted" } else { "" }, style),
        ])
    };
    let tracks = app.song.tracks.as_deref().unwrap_or_default();
    for (i, t) in tracks.iter().enumerate() {
        lines.push(row(
            app.track == i,
            &t.name,
            &t.pattern.id,
            t.channel,
            t.muted,
        ));
    }
    if let Some(m) = &app.song.melody {
        let notes = format!("{} notes", m.notes.len());
        lines.push(row(
            app.track >= tracks.len(),
            "Melody",
            &notes,
            m.channel,
            m.muted,
        ));
    }
    f.render_widget(
        Paragraph::new(lines).block(panel(" Band · t select · m mute ")),
        area,
    );
}

fn render_midi(f: &mut Frame, area: Rect, app: &App, play: &PlayView) {
    let field = |name: &str, value: Span<'static>| {
        Line::from(vec![Span::styled(format!(" {name:<6}"), dim()), value])
    };
    let mut lines = vec![match &play.port {
        Some(port) => field("out", Span::raw(port.clone())),
        None => field("out", Span::styled("none", Style::default().fg(ERROR))),
    }];
    let bar = bar_length(&app.song);
    lines.push(field(
        "now",
        match play.position.filter(|_| play.playing) {
            Some(beat) => Span::styled(
                format!("● playing {}", position_label(beat.floor(), bar)),
                Style::default().fg(ACCENT),
            ),
            None if play.playing => Span::styled("● playing", Style::default().fg(ACCENT)),
            None => Span::styled("○ stopped", dim()),
        },
    ));
    lines.push(field(
        "loop",
        Span::styled(
            app.loop_text(),
            if app.looping {
                Style::default().fg(LOOP)
            } else {
                dim()
            },
        ),
    ));
    lines.push(field(
        "late",
        Span::raw(if play.sent == 0 {
            "–".to_string()
        } else {
            format!(
                "p99 {:.2} max {:.2} ms /{}",
                play.late_p99_us as f64 / 1000.0,
                play.late_max_us as f64 / 1000.0,
                play.sent
            )
        }),
    ));
    if !play.sched.is_empty() {
        lines.push(field("sched", Span::raw(play.sched.clone())));
    }
    lines.push(field("data", Span::raw(app.table_name.clone())));
    f.render_widget(Paragraph::new(lines).block(panel(" MIDI ")), area);
}

fn render_footer(f: &mut Frame, area: Rect, app: &App) {
    let keys = Line::styled(
        " ? help  ←/→ select  ↑/↓ Enter pick  1-7 triad  [ ] length  ( ) loop  Space play  o saves  q quit",
        dim(),
    );
    let status = match &app.error {
        Some(e) => Line::styled(format!(" {e}"), Style::default().fg(ERROR)),
        None if app.status.is_empty() => Line::styled(
            " picks replace the selected chord; on the + slot they add",
            dim(),
        ),
        None => Line::raw(format!(" {}", app.status)),
    };
    f.render_widget(Paragraph::new(vec![keys, status]), area);
}

/// A centred box of at most `w` × `h`.
fn overlay(area: Rect, w: u16, h: u16) -> Rect {
    let [row] = Layout::vertical([Constraint::Length(h.min(area.height))])
        .flex(Flex::Center)
        .areas(area);
    let [cell] = Layout::horizontal([Constraint::Length(w.min(area.width))])
        .flex(Flex::Center)
        .areas(row);
    cell
}

fn render_help(f: &mut Frame, area: Rect) {
    let lines: Vec<Line> = HELP
        .iter()
        .map(|(keys, what)| {
            Line::from(vec![
                Span::styled(format!(" {keys:<20}"), Style::default().fg(ACCENT)),
                Span::raw(*what),
            ])
        })
        .collect();
    let rect = overlay(area, 66, lines.len() as u16 + 2);
    f.render_widget(Clear, rect);
    f.render_widget(
        Paragraph::new(lines).block(panel(" Keys · any key closes ")),
        rect,
    );
}

fn render_rename(f: &mut Frame, area: Rect, text: &str) {
    let rect = overlay(area, 60, 4);
    f.render_widget(Clear, rect);
    let lines = vec![
        Line::raw(format!(" {text}▏")),
        Line::styled(" Enter saves the title · C-u clears · Esc cancels", dim()),
    ];
    f.render_widget(Paragraph::new(lines).block(panel(" Title ")), rect);
}

fn render_saves(f: &mut Frame, area: Rect, view: &SavesView) {
    let rows = view.list.len().clamp(1, 14) as u16;
    let rect = overlay(area, 72, rows + 5);
    f.render_widget(Clear, rect);
    let room = usize::from(rows);
    let first = view.index.saturating_sub(room.saturating_sub(1));
    let mut lines: Vec<Line> = Vec::new();
    for (i, s) in view.list.iter().enumerate().skip(first).take(room) {
        let chosen = i == view.index;
        let style = if chosen {
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)
        } else {
            Style::default()
        };
        let open = view.current.as_deref() == Some(s.id.as_str());
        // `2026-10-20T12:34:56.789Z` → `2026-10-20 12:34`
        let when = s
            .updated_at
            .get(..16)
            .unwrap_or(&s.updated_at)
            .replace('T', " ");
        lines.push(Line::from(vec![
            Span::styled(if chosen { " ▸ " } else { "   " }, style),
            Span::styled(fit(&s.title, 30), style),
            Span::styled(fit(&format!("v{}", s.version), 6), style),
            Span::styled(format!("{when} UTC"), dim()),
            Span::styled(
                if open { "  ● open" } else { "" },
                Style::default().fg(ACCENT),
            ),
        ]));
    }
    if view.list.is_empty() {
        lines.push(Line::styled("   nothing saved yet", dim()));
    }
    lines.push(Line::raw(""));
    if view.unreadable > 0 {
        lines.push(Line::styled(
            format!("   {} unreadable file(s) skipped", view.unreadable),
            Style::default().fg(ERROR),
        ));
    }
    let hint = match (view.confirm_delete, view.list.get(view.index)) {
        (true, Some(s)) => Line::styled(
            format!(
                "   Delete \"{}\"? y deletes, any other key keeps it",
                s.title
            ),
            Style::default().fg(ERROR),
        ),
        _ => Line::styled("   Enter open · n new song · d delete · Esc close", dim()),
    };
    lines.push(hint);
    f.render_widget(
        Paragraph::new(lines).block(panel(format!(" Saved progressions ({}) ", view.list.len()))),
        rect,
    );
}
