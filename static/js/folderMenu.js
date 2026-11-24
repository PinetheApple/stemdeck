import { menuItem, menuSeparator, openMenu } from "./floatMenu.js";
import { t } from "./i18n.js";

/**
 * Open the menu for the folder called `name` from `anchor`, or close it when already open there.
 * "Make a setlist" is disabled unless `canMakeSetlist`.
 */
export function openFolderMenu(
  anchor,
  name,
  { rename, addSubfolder, makeSetlist, remove },
  { canMakeSetlist },
) {
  const deleteItem = menuItem(t("folder.deleteFolder"), "trash", remove);
  deleteItem.classList.add("is-danger");
  openMenu(
    anchor,
    [
      menuItem(t("trackMenu.rename"), "pencil", rename),
      menuItem(t("folder.newSubfolder"), "folderPlus", addSubfolder),
      menuItem(t("folder.makeSetlist"), "listPlus", makeSetlist, { disabled: !canMakeSetlist }),
      menuSeparator(),
      deleteItem,
    ],
    { label: t("trackMenu.openTitle", { title: name }) },
  );
}
