//! `--latency-test`: ping-pong note-ons through a MIDI path and report the round trip.
//! Default path is an in-process ALSA sequencer loopback (our output -> our own virtual
//! input), which is the local cost of one hop. With `--out` and `--in` the path goes through
//! anything that echoes, e.g. rtpmidid to another machine that routes its input back.

use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use midir::{MidiInput, MidiOutput};

pub struct Stats {
    pub samples: Vec<f64>,
    pub lost: usize,
}

impl Stats {
    /// Percentile (0-100) of the samples in ms, nearest-rank.
    pub fn percentile(&self, p: f64) -> f64 {
        if self.samples.is_empty() {
            return f64::NAN;
        }
        let mut s = self.samples.clone();
        s.sort_by(f64::total_cmp);
        let rank = ((p / 100.0) * s.len() as f64).ceil() as usize;
        s[rank.clamp(1, s.len()) - 1]
    }

    pub fn mean(&self) -> f64 {
        self.samples.iter().sum::<f64>() / self.samples.len() as f64
    }

    pub fn report(&self, path: &str) -> String {
        format!(
            "path: {path}\nround trips: {} ok, {} lost\nmin {:.3} ms  median {:.3} ms  mean {:.3} ms  p99 {:.3} ms  max {:.3} ms",
            self.samples.len(),
            self.lost,
            self.percentile(0.0),
            self.percentile(50.0),
            self.mean(),
            self.percentile(99.0),
            self.percentile(100.0),
        )
    }
}

fn find<T>(ports: Vec<T>, name: impl Fn(&T) -> String, wanted: &str) -> Option<T> {
    ports.into_iter().find(|p| name(p).contains(wanted))
}

/// Run `count` round trips. `route` = None: in-process loopback; Some((out, in)): external.
pub fn run(count: usize, route: Option<(&str, &str)>) -> Result<String, String> {
    let (tx, rx) = mpsc::channel::<(u8, Instant)>();
    let callback = move |_ts: u64, msg: &[u8], _: &mut ()| {
        if msg.len() == 3 && msg[0] & 0xf0 == 0x90 && msg[2] > 0 {
            let _ = tx.send((msg[1], Instant::now()));
        }
    };
    let input = MidiInput::new("croky-latency").map_err(|e| e.to_string())?;
    let output = MidiOutput::new("croky-latency").map_err(|e| e.to_string())?;

    let (path, _in_conn, mut out_conn);
    match route {
        None => {
            use midir::os::unix::VirtualInput;
            _in_conn = input
                .create_virtual("loop-in", callback, ())
                .map_err(|e| e.to_string())?;
            // The ALSA sequencer needs a moment before the new port is listed.
            thread::sleep(Duration::from_millis(50));
            let port = find(
                output.ports(),
                |p| output.port_name(p).unwrap_or_default(),
                "croky-latency:loop-in",
            )
            .ok_or("own virtual input port not found")?;
            path =
                "ALSA sequencer loopback (croky-latency out -> croky-latency:loop-in)".to_string();
            out_conn = output
                .connect(&port, "loop-out")
                .map_err(|e| e.to_string())?;
        }
        Some((out_name, in_name)) => {
            let in_port = find(
                input.ports(),
                |p| input.port_name(p).unwrap_or_default(),
                in_name,
            )
            .ok_or(format!("no MIDI input matching '{in_name}'"))?;
            let out_port = find(
                output.ports(),
                |p| output.port_name(p).unwrap_or_default(),
                out_name,
            )
            .ok_or(format!("no MIDI output matching '{out_name}'"))?;
            path = format!(
                "{} -> (echo) -> {}",
                output.port_name(&out_port).unwrap_or_default(),
                input.port_name(&in_port).unwrap_or_default()
            );
            _in_conn = input
                .connect(&in_port, "latency-in", callback, ())
                .map_err(|e| e.to_string())?;
            out_conn = output
                .connect(&out_port, "latency-out")
                .map_err(|e| e.to_string())?;
        }
    }

    let mut stats = Stats {
        samples: Vec::with_capacity(count),
        lost: 0,
    };
    for i in 0..count {
        let note = 36 + (i % 48) as u8;
        while rx.try_recv().is_ok() {} // drop stragglers from a lost round
        let sent = Instant::now();
        out_conn.send(&[0x90, note, 1]).map_err(|e| e.to_string())?;
        let deadline = sent + Duration::from_millis(500);
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left) {
                Ok((n, at)) if n == note => {
                    stats
                        .samples
                        .push(at.duration_since(sent).as_secs_f64() * 1000.0);
                    break;
                }
                Ok(_) => continue,
                Err(_) => {
                    stats.lost += 1;
                    break;
                }
            }
        }
        out_conn.send(&[0x80, note, 0]).map_err(|e| e.to_string())?;
        thread::sleep(Duration::from_millis(2));
    }
    Ok(stats.report(&path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentiles_use_nearest_rank() {
        let s = Stats {
            samples: vec![4.0, 1.0, 3.0, 2.0],
            lost: 0,
        };
        assert_eq!(s.percentile(0.0), 1.0);
        assert_eq!(s.percentile(50.0), 2.0);
        assert_eq!(s.percentile(100.0), 4.0);
        assert_eq!(s.mean(), 2.5);
    }
}
