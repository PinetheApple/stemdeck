// A library folder's … menu: rename it, add a subfolder to it, or delete it.
// catalog.js owns the folders, so it hands in what each item does.

import { menuItem, menuSeparator, openMenu } from "./trackMenu.js";
import { t } from "./i18n.js";

/** Open the menu for the folder called `name` from `anchor`, or close it when already open there. */
export function openFolderMenu(anchor, name, { rename, addSubfolder, remove }) {
  const deleteItem = menuItem(t("folder.deleteFolder"), "trash", remove);
  deleteItem.classList.add("is-danger");
  openMenu(
    anchor,
    [
      menuItem(t("trackMenu.rename"), "pencil", rename),
      menuItem(t("folder.newSubfolder"), "folderPlus", addSubfolder),
      menuSeparator(),
      deleteItem,
    ],
    { label: t("trackMenu.openTitle", { title: name }) },
  );
}
