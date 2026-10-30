//! UI language, from the `language` setting. English is the default.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    En,
    Pt,
    Id,
}

impl Lang {
    /// "pt" and "id" are explicit; anything else (including a missing or unknown value) is English.
    pub fn from_setting(setting: &str) -> Lang {
        match setting {
            "pt" => Lang::Pt,
            "id" => Lang::Id,
            _ => Lang::En,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_setting_is_english() {
        assert_eq!(Lang::from_setting("en"), Lang::En);
        assert_eq!(Lang::from_setting(""), Lang::En);
        assert_eq!(Lang::from_setting("auto"), Lang::En);
        assert_eq!(Lang::from_setting("pt"), Lang::Pt);
        assert_eq!(Lang::from_setting("id"), Lang::Id);
    }
}
