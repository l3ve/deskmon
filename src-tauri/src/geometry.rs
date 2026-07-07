use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const MIN_MARGIN: f64 = 24.0;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Rect {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Point {
    pub(crate) x: f64,
    pub(crate) y: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Dimensions {
    pub(crate) width: f64,
    pub(crate) height: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MonitorPayload {
    pub(crate) name: Option<String>,
    pub(crate) position: Point,
    pub(crate) size: Dimensions,
    pub(crate) work_area: Rect,
    pub(crate) scale_factor: f64,
}

pub(crate) fn collect_monitors(app: &AppHandle) -> Result<Vec<MonitorPayload>, String> {
    let monitors = app.available_monitors().map_err(|err| err.to_string())?;
    Ok(monitors
        .into_iter()
        .map(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            let work_area = monitor.work_area();
            MonitorPayload {
                name: monitor.name().map(ToOwned::to_owned),
                position: Point {
                    x: position.x as f64,
                    y: position.y as f64,
                },
                size: Dimensions {
                    width: size.width as f64,
                    height: size.height as f64,
                },
                work_area: Rect {
                    x: work_area.position.x as f64,
                    y: work_area.position.y as f64,
                    width: work_area.size.width as f64,
                    height: work_area.size.height as f64,
                },
                scale_factor: monitor.scale_factor(),
            }
        })
        .collect())
}

pub(crate) fn default_activity_area(monitors: &[MonitorPayload]) -> Rect {
    let work = monitors
        .first()
        .map(|monitor| monitor.work_area)
        .unwrap_or(Rect {
            x: 0.0,
            y: 0.0,
            width: 1200.0,
            height: 800.0,
        });
    Rect {
        x: work.x + MIN_MARGIN,
        y: work.y + MIN_MARGIN,
        width: (work.width - MIN_MARGIN * 2.0).max(240.0),
        height: (work.height - MIN_MARGIN * 2.0).max(180.0),
    }
}

pub(crate) fn normalize_activity_area(
    area: Rect,
    default_area: Rect,
    pet_dimensions: Dimensions,
) -> Option<Rect> {
    let min_width = pet_dimensions.width * 3.0;
    let min_height = pet_dimensions.height * 2.0;
    if area.width < min_width || area.height < min_height {
        return None;
    }

    let x = area.x.max(default_area.x);
    let y = area.y.max(default_area.y);
    let right = (area.x + area.width).min(default_area.x + default_area.width);
    let bottom = (area.y + area.height).min(default_area.y + default_area.height);
    let normalized = Rect {
        x,
        y,
        width: (right - x).max(0.0),
        height: (bottom - y).max(0.0),
    };

    if normalized.width >= min_width && normalized.height >= min_height {
        Some(normalized)
    } else {
        None
    }
}

pub(crate) fn initial_pet_position(activity_area: Rect, pet_dimensions: Dimensions) -> Point {
    Point {
        x: activity_area.x + (activity_area.width - pet_dimensions.width).max(0.0) * 0.78,
        y: activity_area.y + (activity_area.height - pet_dimensions.height).max(0.0) * 0.72,
    }
}

pub(crate) fn point_visible(
    point: Point,
    pet_dimensions: Dimensions,
    monitors: &[MonitorPayload],
) -> bool {
    monitors.iter().any(|monitor| {
        let work = monitor.work_area;
        point.x >= work.x
            && point.y >= work.y
            && point.x + pet_dimensions.width <= work.x + work.width
            && point.y + pet_dimensions.height <= work.y + work.height
    })
}

pub(crate) fn clamp_to_visible_work_area(
    point: Point,
    pet_dimensions: Dimensions,
    monitors: &[MonitorPayload],
) -> Point {
    let work = monitors
        .iter()
        .find(|monitor| {
            point.x >= monitor.work_area.x
                && point.x <= monitor.work_area.x + monitor.work_area.width
                && point.y >= monitor.work_area.y
                && point.y <= monitor.work_area.y + monitor.work_area.height
        })
        .map(|monitor| monitor.work_area)
        .or_else(|| monitors.first().map(|monitor| monitor.work_area))
        .unwrap_or(Rect {
            x: 0.0,
            y: 0.0,
            width: 1200.0,
            height: 800.0,
        });

    Point {
        x: point.x.clamp(
            work.x,
            (work.x + work.width - pet_dimensions.width).max(work.x),
        ),
        y: point.y.clamp(
            work.y,
            (work.y + work.height - pet_dimensions.height).max(work.y),
        ),
    }
}

pub(crate) fn pet_physical_dimensions(
    logical_dimensions: Dimensions,
    monitors: &[MonitorPayload],
    position: Option<Point>,
) -> Dimensions {
    let scale_factor = position
        .and_then(|point| monitor_for_point(point, monitors))
        .or_else(|| monitors.first())
        .map(|monitor| monitor.scale_factor)
        .unwrap_or(1.0);

    Dimensions {
        width: logical_dimensions.width * scale_factor,
        height: logical_dimensions.height * scale_factor,
    }
}

fn monitor_for_point(point: Point, monitors: &[MonitorPayload]) -> Option<&MonitorPayload> {
    monitors.iter().find(|monitor| {
        point.x >= monitor.work_area.x
            && point.x <= monitor.work_area.x + monitor.work_area.width
            && point.y >= monitor.work_area.y
            && point.y <= monitor.work_area.y + monitor.work_area.height
    })
}
