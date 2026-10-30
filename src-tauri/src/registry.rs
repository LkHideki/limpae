//! Backend-side store of scan results. The UI only ever sees numeric ids; it can never name a path to remove.
//! Ids come from one global monotonic counter and are never reused, so an id from an older scan cannot
//! resolve to an item of a newer one.

use std::collections::{HashMap, HashSet};

use limpa_core::{Group, Item};

use crate::dto::{GroupDto, ItemDto};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Task {
    Junk,
    Trash,
    Large,
    /// Leftovers of the app with this id; removable only through `uninstall`.
    Leftovers(u64),
}

struct Entry {
    item: Item,
    task: Task,
}

/// Result of resolving ids for a removal: what to remove, and what was refused (with a user-facing reason).
#[derive(Debug, Default)]
pub struct Resolved {
    pub items: Vec<(u64, Item)>,
    pub rejected: Vec<(u64, &'static str)>,
}

pub const ERR_UNKNOWN_ITEM: &str = "item desconhecido";
pub const ERR_LEFTOVER_VIA_REMOVE: &str = "restos de app só podem ser removidos pela desinstalação do app";
pub const ERR_LEFTOVER_OTHER_APP: &str = "item não pertence a este app";

#[derive(Default)]
pub struct Registry {
    next_id: u64,
    entries: HashMap<u64, Entry>,
}

impl Registry {
    #[cfg(test)]
    pub fn new() -> Self {
        Self::default()
    }

    /// Fresh id from the shared counter (also used for apps, so ids never collide across kinds).
    pub fn alloc_id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    /// Drops the previous entries of `task`, stores `groups` under fresh ids and returns their DTOs.
    pub fn replace(&mut self, task: Task, groups: Vec<Group>) -> Vec<GroupDto> {
        self.entries.retain(|_, e| e.task != task);
        groups
            .into_iter()
            .map(|g| {
                let total = g.total();
                let items = g
                    .items
                    .into_iter()
                    .map(|item| {
                        let id = self.alloc_id();
                        let dto = ItemDto::new(id, &item);
                        self.entries.insert(id, Entry { item, task });
                        dto
                    })
                    .collect();
                GroupDto { id: g.id, title: g.title, description: g.description, total, items }
            })
            .collect()
    }

    /// Known items for `ids` (deduplicated, input order) and the ids that resolve to nothing.
    pub fn get(&self, ids: &[u64]) -> (Vec<(u64, Item)>, Vec<u64>) {
        let mut seen = HashSet::new();
        let mut found = Vec::new();
        let mut unknown = Vec::new();
        for &id in ids.iter().filter(|id| seen.insert(**id)) {
            match self.entries.get(&id) {
                Some(e) => found.push((id, e.item.clone())),
                None => unknown.push(id),
            }
        }
        (found, unknown)
    }

    #[cfg(test)]
    pub fn task_of(&self, id: u64) -> Option<Task> {
        self.entries.get(&id).map(|e| e.task)
    }

    pub fn forget(&mut self, ids: &[u64]) {
        for id in ids {
            self.entries.remove(id);
        }
    }

    /// Ids for the generic `remove` command: leftovers are refused, they belong to `uninstall`.
    pub fn resolve_removal(&self, ids: &[u64]) -> Resolved {
        self.resolve(ids, |task| match task {
            Task::Leftovers(_) => Err(ERR_LEFTOVER_VIA_REMOVE),
            _ => Ok(()),
        })
    }

    /// Ids for `uninstall(app_id)`: only leftovers found for exactly that app are accepted.
    pub fn resolve_leftovers(&self, app_id: u64, ids: &[u64]) -> Resolved {
        self.resolve(ids, |task| match task {
            Task::Leftovers(a) if a == app_id => Ok(()),
            _ => Err(ERR_LEFTOVER_OTHER_APP),
        })
    }

    fn resolve(&self, ids: &[u64], accept: impl Fn(Task) -> Result<(), &'static str>) -> Resolved {
        let mut seen = HashSet::new();
        let mut out = Resolved::default();
        for &id in ids.iter().filter(|id| seen.insert(**id)) {
            match self.entries.get(&id) {
                None => out.rejected.push((id, ERR_UNKNOWN_ITEM)),
                Some(e) => match accept(e.task) {
                    Ok(()) => out.items.push((id, e.item.clone())),
                    Err(reason) => out.rejected.push((id, reason)),
                },
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use limpa_core::Policy;
    use std::path::PathBuf;

    fn group(id: &str, names: &[(&str, u64)]) -> Group {
        Group {
            id: id.into(),
            title: id.into(),
            description: String::new(),
            items: names
                .iter()
                .map(|(n, s)| Item::new(PathBuf::from(format!("/nonexistent/{n}")), *s, Policy::MoveToTrash))
                .collect(),
        }
    }

    fn ids(groups: &[GroupDto]) -> Vec<u64> {
        groups.iter().flat_map(|g| g.items.iter().map(|i| i.id)).collect()
    }

    #[test]
    fn replace_assigns_ids_and_totals() {
        let mut r = Registry::new();
        let dto = r.replace(Task::Junk, vec![group("a", &[("x", 10), ("y", 5)])]);
        assert_eq!(dto[0].total, 15);
        assert_eq!(dto[0].items.len(), 2);
        let found = r.get(&ids(&dto)).0;
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].1.name, "x");
    }

    #[test]
    fn replace_drops_only_same_task() {
        let mut r = Registry::new();
        let junk1 = ids(&r.replace(Task::Junk, vec![group("a", &[("x", 1)])]));
        let large = ids(&r.replace(Task::Large, vec![group("b", &[("y", 2)])]));
        let junk2 = ids(&r.replace(Task::Junk, vec![group("a", &[("z", 3)])]));

        let (found, unknown) = r.get(&junk1);
        assert!(found.is_empty());
        assert_eq!(unknown, junk1);
        assert_eq!(r.get(&large).0.len(), 1);
        assert_eq!(r.get(&junk2).0[0].1.name, "z");
    }

    #[test]
    fn replace_with_nothing_clears_task() {
        let mut r = Registry::new();
        let old = ids(&r.replace(Task::Trash, vec![group("t", &[("x", 1)])]));
        assert!(r.replace(Task::Trash, vec![]).is_empty());
        assert_eq!(r.get(&old).1, old);
    }

    #[test]
    fn ids_are_never_reused() {
        let mut r = Registry::new();
        let mut all = HashSet::new();
        for _ in 0..5 {
            for id in ids(&r.replace(Task::Junk, vec![group("a", &[("x", 1), ("y", 1)])])) {
                assert!(all.insert(id), "id {id} reused");
            }
        }
        // Ids handed out for apps come from the same counter.
        assert!(all.insert(r.alloc_id()));
        // Forgetting does not free ids either.
        let last = ids(&r.replace(Task::Large, vec![group("b", &[("w", 1)])]));
        r.forget(&last);
        let next = ids(&r.replace(Task::Large, vec![group("b", &[("w", 1)])]));
        assert!(all.insert(next[0]) && !last.contains(&next[0]));
    }

    #[test]
    fn unknown_ids_are_reported_and_duplicates_collapsed() {
        let mut r = Registry::new();
        let known = ids(&r.replace(Task::Junk, vec![group("a", &[("x", 1)])]));
        let (found, unknown) = r.get(&[known[0], 9999, known[0], 9999]);
        assert_eq!(found.len(), 1);
        assert_eq!(unknown, vec![9999]);
    }

    #[test]
    fn forget_removes_only_listed_ids() {
        let mut r = Registry::new();
        let v = ids(&r.replace(Task::Junk, vec![group("a", &[("x", 1), ("y", 1)])]));
        r.forget(&v[..1]);
        assert_eq!(r.get(&v).0.len(), 1);
        assert_eq!(r.task_of(v[1]), Some(Task::Junk));
        assert_eq!(r.task_of(v[0]), None);
    }

    #[test]
    fn leftovers_are_refused_by_remove() {
        let mut r = Registry::new();
        let junk = ids(&r.replace(Task::Junk, vec![group("a", &[("x", 1)])]));
        let left = ids(&r.replace(Task::Leftovers(7), vec![group("leftovers", &[("l", 1)])]));
        let res = r.resolve_removal(&[junk[0], left[0], 12345]);
        assert_eq!(res.items.len(), 1);
        assert_eq!(res.items[0].0, junk[0]);
        assert_eq!(res.rejected, vec![(left[0], ERR_LEFTOVER_VIA_REMOVE), (12345, ERR_UNKNOWN_ITEM)]);
    }

    #[test]
    fn uninstall_accepts_only_leftovers_of_that_app() {
        let mut r = Registry::new();
        let junk = ids(&r.replace(Task::Junk, vec![group("a", &[("x", 1)])]));
        let mine = ids(&r.replace(Task::Leftovers(7), vec![group("leftovers", &[("l", 1)])]));
        let other = ids(&r.replace(Task::Leftovers(8), vec![group("leftovers", &[("m", 1)])]));
        // Another app's scan must not evict this app's leftovers.
        assert_eq!(r.get(&mine).0.len(), 1);

        let res = r.resolve_leftovers(7, &[mine[0], other[0], junk[0], 424242]);
        assert_eq!(res.items.iter().map(|(id, _)| *id).collect::<Vec<_>>(), mine);
        assert_eq!(
            res.rejected,
            vec![(other[0], ERR_LEFTOVER_OTHER_APP), (junk[0], ERR_LEFTOVER_OTHER_APP), (424242, ERR_UNKNOWN_ITEM)]
        );
    }

    #[test]
    fn rescanning_leftovers_of_one_app_keeps_other_apps() {
        let mut r = Registry::new();
        let a_old = ids(&r.replace(Task::Leftovers(1), vec![group("leftovers", &[("a", 1)])]));
        let b = ids(&r.replace(Task::Leftovers(2), vec![group("leftovers", &[("b", 1)])]));
        let a_new = ids(&r.replace(Task::Leftovers(1), vec![group("leftovers", &[("a", 1)])]));
        assert_eq!(r.get(&a_old).1, a_old);
        assert_eq!(r.get(&b).0.len(), 1);
        assert_eq!(r.get(&a_new).0.len(), 1);
    }
}
