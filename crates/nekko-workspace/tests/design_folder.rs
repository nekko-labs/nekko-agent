//! The board following the project's `nekko-designs/` folder: files agents
//! add become cards, edits to a card's file show on the card, and a removed
//! card stays removed while its file remains.

use nekko_workspace::design;
use serde_json::{Value, json};
use std::path::Path;

fn pages(board: &Value) -> &Vec<Value> {
    board["pages"].as_array().unwrap()
}

fn text(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

#[test]
fn adopts_designs_saved_into_the_folder_once() {
    let (data, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let designs = project.path().join("nekko-designs");
    std::fs::create_dir_all(designs.join("nested")).unwrap();
    std::fs::write(
        designs.join("checkout-design.html"),
        "<!doctype html><title>\n  Checkout:  three   states </title><p>a</p>",
    )
    .unwrap();
    std::fs::write(designs.join("pricing_mockup.HTM"), "<main>no title</main>").unwrap();
    // Not designs the board can hold: another type, a file with no markup, a binary, a subfolder's file.
    std::fs::write(designs.join("notes.md"), "# notes").unwrap();
    std::fs::write(designs.join("empty.html"), "plain words").unwrap();
    std::fs::write(designs.join("binary.html"), [b'<', 0, 1, 2]).unwrap();
    std::fs::write(designs.join("nested").join("deep.html"), "<p>deep</p>").unwrap();
    let (ws, folder) = (json!("w1"), text(project.path()));

    let board = design::follow_folder(data.path(), Some(&ws), Some(&folder)).unwrap();
    let cards = pages(&board);
    assert_eq!(cards.len(), 2, "{board}");
    assert_eq!(cards[0]["label"], "Checkout: three states");
    assert_eq!(cards[0]["kind"], "concept");
    assert_eq!(cards[0]["origin"], "file");
    assert_eq!(cards[0]["url"], "");
    assert_eq!(cards[0]["notes"], json!([]));
    assert!(cards[0]["html"].as_str().unwrap().ends_with("<p>a</p>"));
    assert_eq!(Path::new(cards[0]["file"].as_str().unwrap()), designs.join("checkout-design.html"));
    assert_eq!(cards[1]["label"], "Pricing mockup");
    assert!(cards[0].get("revisions").is_none());

    // Opening the board again adopts nothing twice, and the plain read agrees.
    let again = design::follow_folder(data.path(), Some(&ws), Some(&folder)).unwrap();
    assert_eq!(again, board);
    assert_eq!(design::get(data.path(), Some(&ws)), board);
    // Another workspace's board is its own.
    assert!(pages(&design::get(data.path(), Some(&json!("w2")))).is_empty());
}

#[test]
fn leaves_the_store_alone_when_there_is_nothing_to_follow() {
    let (data, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let ws = json!("w1");
    // No saved folder, then a folder with no designs folder: an empty board and no store file.
    for folder in [None, Some(text(project.path()))] {
        let board = design::follow_folder(data.path(), Some(&ws), folder.as_deref()).unwrap();
        assert_eq!(board, json!({ "workspaceId": "w1", "pages": [] }));
    }
    assert!(!data.path().join("design.json").exists());
    assert!(!project.path().join("nekko-designs").exists());
}

#[test]
fn shows_an_edit_to_a_cards_file_and_keeps_the_old_html_as_a_revision() {
    let (data, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (ws, folder) = (json!("w1"), text(project.path()));
    // A concept the Design tab generated: its HTML on the board and mirrored into the folder.
    let input = json!({ "prompt": "a login page" });
    let plan = design::plan(data.path(), Some(&ws), &input).unwrap();
    let board = design::land(data.path(), Some(&ws), &input, &plan, "<html><p>v1</p></html>", Some(&folder)).unwrap();
    let file = pages(&board)[0]["file"].as_str().unwrap().to_string();
    let same = design::follow_folder(data.path(), Some(&ws), Some(&folder)).unwrap();
    assert_eq!(same, board, "an unchanged file changes nothing");

    // An agent edits the file in place.
    std::fs::write(&file, "<html><p>v2, by an agent</p></html>").unwrap();
    let board = design::follow_folder(data.path(), Some(&ws), Some(&folder)).unwrap();
    let card = &pages(&board)[0];
    assert_eq!(pages(&board).len(), 1);
    assert_eq!(card["html"], "<html><p>v2, by an agent</p></html>");
    assert_eq!(card["origin"], "prompt");
    assert_eq!(card["prompt"], "a login page");
    assert_eq!(card["revisions"].as_array().unwrap().len(), 1);
    assert_eq!(card["revisions"][0]["html"], "<html><p>v1</p></html>");

    // A refinement now starts from the agent's version, not the stale one.
    let refine = json!({ "prompt": "darker", "pageId": card["id"] });
    let plan = design::plan(data.path(), Some(&ws), &refine).unwrap();
    assert!(plan.ask.contains("v2, by an agent"), "{}", plan.ask);

    // A file that is gone, or no longer a page the board can hold, leaves the card as it was.
    std::fs::write(&file, "not markup any more").unwrap();
    assert_eq!(design::follow_folder(data.path(), Some(&ws), Some(&folder)).unwrap(), board);
    std::fs::remove_file(&file).unwrap();
    assert_eq!(design::follow_folder(data.path(), Some(&ws), Some(&folder)).unwrap(), board);
}

#[test]
fn a_removed_card_stays_removed_while_its_file_remains() {
    let (data, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let designs = project.path().join("nekko-designs");
    std::fs::create_dir_all(&designs).unwrap();
    std::fs::write(designs.join("a.html"), "<p>a</p>").unwrap();
    std::fs::write(designs.join("b.html"), "<p>b</p>").unwrap();
    let (ws, folder) = (json!("w1"), text(project.path()));
    let board = design::follow_folder(data.path(), Some(&ws), Some(&folder)).unwrap();
    let a = pages(&board)[0]["id"].clone();

    let board = design::remove_page(data.path(), Some(&ws), Some(&a)).unwrap();
    assert_eq!(pages(&board).iter().map(|p| p["label"].as_str().unwrap()).collect::<Vec<_>>(), ["B"]);
    assert!(designs.join("a.html").exists(), "removing a card never deletes its file");
    let board = design::follow_folder(data.path(), Some(&ws), Some(&folder)).unwrap();
    assert_eq!(pages(&board).len(), 1, "{board}");

    // A new file is still adopted, and removing a card with no such id or no file records nothing.
    std::fs::write(designs.join("c.html"), "<p>c</p>").unwrap();
    design::remove_page(data.path(), Some(&ws), Some(&json!("missing"))).unwrap();
    let board = design::follow_folder(data.path(), Some(&ws), Some(&folder)).unwrap();
    assert_eq!(pages(&board).iter().map(|p| p["label"].as_str().unwrap()).collect::<Vec<_>>(), ["B", "C"]);
    let store: Value =
        serde_json::from_str(&std::fs::read_to_string(data.path().join("design.json")).unwrap()).unwrap();
    assert_eq!(store["w1#dismissed"].as_array().unwrap().len(), 1);
}

#[test]
fn keeps_a_readme_index_of_the_board_in_the_folder() {
    let (data, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (ws, folder) = (json!("w1"), text(project.path()));
    let designs = project.path().join("nekko-designs");
    let readme = designs.join("README.md");

    // No designs folder: nothing is created.
    let board = design::follow_folder(data.path(), Some(&ws), Some(&folder)).unwrap();
    assert!(!design::write_index(&folder, &board).unwrap());
    assert!(!designs.exists());

    std::fs::create_dir_all(&designs).unwrap();
    std::fs::write(designs.join("checkout-design.html"), "<title>Checkout | states</title><p>a</p>").unwrap();
    let board = design::follow_folder(data.path(), Some(&ws), Some(&folder)).unwrap();
    let id = board["pages"][0]["id"].clone();
    let board = design::add_note(data.path(), Some(&ws), Some(&id), Some(&json!("Make the\nbutton bigger"))).unwrap();
    assert!(design::write_index(&folder, &board).unwrap());
    let text = std::fs::read_to_string(&readme).unwrap();
    assert!(text.starts_with(design::INDEX_MARKER), "{text}");
    assert!(text.contains("| Checkout \\| states | checkout-design.html | Make the button bigger |"), "{text}");

    // Unchanged board: no write. A resolved note leaves the row.
    assert!(!design::write_index(&folder, &board).unwrap());
    let note = board["pages"][0]["notes"][0]["id"].clone();
    let board = design::resolve_note(data.path(), Some(&ws), Some(&id), Some(&note)).unwrap();
    assert!(design::write_index(&folder, &board).unwrap());
    assert!(std::fs::read_to_string(&readme).unwrap().contains("| checkout-design.html |  |"));

    // The README is not adopted as a design, and a README the person wrote is left alone.
    assert_eq!(pages(&design::follow_folder(data.path(), Some(&ws), Some(&folder)).unwrap()).len(), 1);
    std::fs::write(&readme, "# My own notes").unwrap();
    assert!(!design::write_index(&folder, &board).unwrap());
    assert_eq!(std::fs::read_to_string(&readme).unwrap(), "# My own notes");
}
