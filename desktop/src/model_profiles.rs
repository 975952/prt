//! Saved model configurations. Keep the contract aligned with model-profiles.js.
use serde_json::{json, Map, Value};

const FIELDS: [&str; 6] = ["model", "baseURL", "apiKey", "visionModel", "temperature", "stream"];
pub const CONTROL_FIELDS: [&str; 4] = ["profileAction", "profileId", "profileName", "selectProfile"];

fn values(source: &Value) -> Value {
    let mut out = Map::new();
    for key in FIELDS {
        let fallback = match key { "stream" => json!(true), "temperature" => json!(0.2), _ => json!("") };
        out.insert(key.into(), source.get(key).filter(|v| !v.is_null()).cloned().unwrap_or(fallback));
    }
    Value::Object(out)
}

struct Profiles { list: Vec<Value>, active: String, serial: u64 }

fn profiles(cfg: &Value) -> Profiles {
    let stored: Vec<&Value> = cfg.get("modelProfiles").and_then(Value::as_array)
        .map(|rows| rows.iter().filter(|p| p.is_object()).collect()).unwrap_or_default();
    let mut serial = cfg.get("modelProfileSerial").and_then(Value::as_u64).unwrap_or(0);
    for p in &stored {
        if let Some(n) = p["id"].as_str().and_then(|s| s.strip_prefix("profile-")).and_then(|s| s.parse::<u64>().ok()) {
            serial = serial.max(n);
        }
    }
    let mut used = std::collections::HashSet::new();
    let mut list = Vec::new();
    for p in stored {
        let existing = p["id"].as_str().unwrap_or("");
        let id = if !existing.is_empty() && existing.len() <= 80
            && existing.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') && !used.contains(existing) {
            existing.to_string()
        } else { serial += 1; format!("profile-{serial}") };
        used.insert(id.clone());
        let mut item = values(p);
        item["id"] = json!(id);
        item["name"] = json!(p["name"].as_str().unwrap_or(""));
        list.push(item);
    }
    let mut active = cfg["activeProfile"].as_str().filter(|id| list.iter().any(|p| p["id"].as_str() == Some(id))).unwrap_or("").to_string();
    // Only migrate anonymous legacy snapshots once. Never resurrect a deleted list.
    if cfg.get("activeProfile").is_none() {
        let current = values(cfg);
        active = list.iter().find(|p| FIELDS.iter().all(|k| p.get(*k) == current.get(*k)))
            .and_then(|p| p["id"].as_str()).unwrap_or("").to_string();
        if active.is_empty() && FIELDS.iter().any(|k| current[*k].as_str().map(|s| !s.is_empty()).unwrap_or(false)) {
            serial += 1;
            active = format!("profile-{serial}");
            let mut p = current;
            p["id"] = json!(active);
            p["name"] = json!("");
            list.push(p);
        }
    }
    Profiles { list, active, serial }
}

fn activate(next: &mut Value, active: &mut String, profile: Option<&Value>) {
    let empty = Value::Null;
    let p = profile.unwrap_or(&empty);
    let fields = values(p);
    for key in FIELDS { next[key] = fields[key].clone(); }
    *active = p["id"].as_str().unwrap_or("").to_string();
}

pub fn public_config(cfg: &Value) -> Value {
    let state = profiles(cfg);
    let mut out = cfg.clone();
    out["hasApiKey"] = json!(cfg["apiKey"].as_str().map(|s| !s.is_empty()).unwrap_or(false));
    out["apiKey"] = json!("");
    out["activeProfile"] = json!(state.active);
    out["modelProfiles"] = json!(state.list.into_iter().map(|mut p| {
        let key = p.as_object_mut().unwrap().remove("apiKey").unwrap_or(Value::Null);
        p["hasApiKey"] = json!(key.as_str().map(|s| !s.is_empty()).unwrap_or(false));
        p
    }).collect::<Vec<_>>());
    out
}

pub fn save_profiles(cur: &Value, next: &mut Value, raw: &Value, patch: &Value) -> Result<(), String> {
    let mut state = profiles(cur);
    let action = if raw.get("selectProfile").is_some() { Some("select") }
        else if let Some(value) = raw.get("profileAction") { Some(value.as_str().ok_or("未知的模型配置操作")?) } else { None };
    if action.map(|a| !["create", "save", "select", "delete"].contains(&a)).unwrap_or(false) { return Err("未知的模型配置操作".into()); }
    if raw.get("selectProfile").is_some() && raw.get("profileAction").is_some() { return Err("一次只能执行一种模型配置操作".into()); }
    if matches!(action, Some("delete" | "select")) && FIELDS.iter().any(|key| raw.get(*key).is_some()) { return Err("切换或删除配置时不能同时修改模型字段".into()); }
    let id = raw.get("selectProfile").or_else(|| raw.get("profileId")).and_then(Value::as_str);
    let index = id.and_then(|id| state.list.iter().position(|p| p["id"].as_str() == Some(id)));
    if matches!(action, Some("delete" | "select" | "save")) && index.is_none() { return Err("模型配置不存在，请重新打开设置".into()); }
    match action {
        Some("delete") => {
            let index = index.unwrap();
            let removed = state.list.remove(index);
            if removed["id"].as_str() == Some(&state.active) {
                let following = state.list.get(index.min(state.list.len().saturating_sub(1)));
                activate(next, &mut state.active, following);
            }
        },
        Some("select") => activate(next, &mut state.active, state.list.get(index.unwrap())),
        Some("create" | "save") => {
            for key in FIELDS {
                if raw.get(key).is_some() && patch.get(key).is_none() { return Err(format!("模型配置字段无效：{key}")); }
            }
            if let Some(name) = raw.get("profileName") {
                if name.as_str().map(|s| s.chars().count() > 80).unwrap_or(true) { return Err("配置名称最多 80 个字符".into()); }
            }
            let mut p = if action == Some("save") { state.list[index.unwrap()].clone() } else {
                state.serial += 1;
                let mut p = values(&Value::Null);
                p["id"] = json!(format!("profile-{}", state.serial));
                p["name"] = json!("");
                p
            };
            for key in FIELDS {
                if let Some(value) = patch.get(key) {
                    if key != "apiKey" || value.as_str().map(|s| !s.is_empty()).unwrap_or(false) { p[key] = value.clone(); }
                }
            }
            for key in ["model", "baseURL"] {
                p[key] = json!(p[key].as_str().unwrap_or("").trim());
                if p[key].as_str() == Some("") { return Err("请填写模型名和接口地址".into()); }
            }
            if let Some(name) = raw.get("profileName").and_then(Value::as_str) { p["name"] = json!(name.trim()); }
            activate(next, &mut state.active, Some(&p));
            if action == Some("save") { state.list[index.unwrap()] = p; } else { state.list.push(p); }
        },
        _ => {
            if FIELDS.iter().any(|key| patch.get(*key).is_some()) {
                let index = state.list.iter().position(|p| p["id"].as_str() == Some(&state.active));
                let mut p = values(next);
                if let Some(index) = index {
                    p["id"] = state.list[index]["id"].clone();
                    p["name"] = state.list[index]["name"].clone();
                    state.list[index] = p.clone();
                } else {
                    state.serial += 1;
                    p["id"] = json!(format!("profile-{}", state.serial));
                    p["name"] = json!("");
                    state.list.push(p.clone());
                }
                activate(next, &mut state.active, Some(&p));
            }
        }
    }
    next["modelProfiles"] = json!(state.list);
    next["activeProfile"] = json!(state.active);
    next["modelProfileSerial"] = json!(state.serial);
    Ok(())
}
