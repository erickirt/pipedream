import crypto from "crypto";
import base from "./http-based/base.mjs";

/**
 * This module implements logic common to the "New Row Added" sources. To create
 * a source with this module, extend  {@linkcode ./http-based/base.mjs base.mjs}
 * or one of its "child" modules (`drive.mjs` or `sheet.mjs`).
 */
export default {
  props: {
    worksheetIDs: {
      propDefinition: [
        base.props.googleSheets,
        "worksheetIDs",
        (c) => ({
          sheetId: c.sheetID,
        }),
      ],
      type: "string[]",
      label: "Worksheet ID(s)",
      description: "Select one or more worksheet(s), or provide an array of worksheet IDs.",
    },
  },
  methods: {
    _getRowHashes() {
      return this.db.get("rowHashes") || {};
    },
    _setRowHashes(rowHashes) {
      this.db.set("rowHashes", rowHashes);
    },
    getMeta(worksheet, rowNumber, rowHashString) {
      const ts = Date.now();
      const id = rowHashString;
      const summary = `New row #${rowNumber} in ${worksheet.properties.title}`;
      return {
        id,
        summary,
        ts,
      };
    },
    /**
     * Temporary transformation to ensure the format of the data is the
     * correct one. This will be fixed in the UI and backend, so that the data
     * format is guaranteed to be the one indicated in the `type` field of the
     * user prop.
     */
    getSheetId() {
      return this.sheetID.toString();
    },
    /**
     * Temporary transformation to ensure the format of the data is the
     * correct one. This will be fixed in the UI and backend, so that the data
     * format is guaranteed to be the one indicated in the `type` field of the
     * user prop.
     */
    getWorksheetIds() {
      return this.worksheetIDs.map((i) => i.toString());
    },
    _getRowCount(id) {
      return this.db.get(id) || 0;
    },
    _setRowCount(id, rowCount) {
      this.db.set(id, rowCount);
    },
    async getWorksheetLengthsById() {
      const sheetId = this.getSheetId();
      const relevantWorksheets =
        this.getWorksheetIds().length === 0
          ? await this.getAllWorksheetIds(sheetId)
          : this.getWorksheetIds();
      const worksheetIds = new Set(relevantWorksheets);
      const worksheetLengths = await this.googleSheets.getWorksheetLength(
        sheetId,
      );
      return worksheetLengths
        .map((worksheetLengthData) => {
          const { worksheetId } = worksheetLengthData;
          return {
            ...worksheetLengthData,
            worksheetId: worksheetId.toString(),
          };
        })
        .filter(({ worksheetId }) => worksheetIds.has(worksheetId))
        .reduce(
          (accum, {
            worksheetId,
            worksheetLength,
          }) => ({
            ...accum,
            [worksheetId]: worksheetLength,
          }),
          {},
        );
    },
    /**
     * Initialize row counts (used to keep track of new rows)
     */
    async takeSheetSnapshot(offset = 0) {
      const sheetId = this.getSheetId();
      const worksheetIds =
        this.getWorksheetIds().length === 0
          ? await this.getAllWorksheetIds(sheetId)
          : this.getWorksheetIds();
      const worksheetRowCounts = await this.googleSheets.getWorksheetRowCounts(
        sheetId,
        worksheetIds,
      );
      for (const worksheetRowCount of worksheetRowCounts) {
        const {
          rowCount,
          worksheetId,
        } = worksheetRowCount;
        const offsetRowCount = Math.max(rowCount - offset, 0);
        this._setRowCount(`${sheetId}${worksheetId}`, offsetRowCount);
      }
    },
    async processSpreadsheet(spreadsheet) {
      const sheetId = this.getSheetId();
      const worksheetLengthsById = await this.getWorksheetLengthsById();

      for (const worksheet of spreadsheet.sheets) {
        const {
          sheetId: worksheetId,
          title: worksheetTitle,
        } = worksheet.properties;
        if (
          this.getWorksheetIds().length &&
          !this.isWorksheetRelevant(worksheetId)
        ) {
          continue;
        }

        const oldRowCount = this._getRowCount(`${sheetId}${worksheetId}`);
        const worksheetLength = worksheetLengthsById[worksheetId];
        if (oldRowCount === worksheetLength) {
          // No new rows. Skip getting spreadsheet values, which would include the last row when the
          // (A1 notation) range's upper bound is the worksheet length.
          continue;
        }
        const lowerBound = oldRowCount + 1;
        const upperBound = worksheetLength;
        const range = `${worksheetTitle}!${lowerBound}:${upperBound}`;
        const newRowValues = await this.googleSheets.getSpreadsheetValues(
          sheetId,
          range,
        );

        const newRowCount = oldRowCount + newRowValues.values.length;
        if (newRowCount <= oldRowCount) continue;

        this._setRowCount(
          `${sheetId}${worksheetId}`,
          // https://github.com/PipedreamHQ/pipedream/issues/2818
          newRowCount >= upperBound
            ? upperBound
            : newRowCount,
        );

        const rowHashes = this._getRowHashes();
        for (const [
          index,
          newRow,
        ] of newRowValues.values.entries()) {
          const rowNumber = lowerBound + index;
          const rowHash = crypto
            .createHash("md5")
            .update(JSON.stringify(newRow))
            .digest("base64");
          const rowHashString = `${worksheet.properties.sheetId}${rowNumber}${rowHash}`;
          if (rowHashes[rowHashString]) {
            continue;
          }
          rowHashes[rowHashString] = true;
          this.$emit(
            {
              newRow,
              range,
              worksheet,
              rowNumber,
            },
            this.getMeta(worksheet, rowNumber, rowHashString),
          );
        }
        this._setRowHashes(rowHashes);
      }
    },
  },
};
