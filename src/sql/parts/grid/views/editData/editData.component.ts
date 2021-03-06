/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import 'vs/css!sql/parts/grid/media/slickColorTheme';
import 'vs/css!sql/parts/grid/media/flexbox';
import 'vs/css!sql/parts/grid/media/styles';
import 'vs/css!sql/parts/grid/media/slick.grid';
import 'vs/css!sql/parts/grid/media/slickGrid';
import 'vs/css!./media/editData';

import { ElementRef, ChangeDetectorRef, OnInit, OnDestroy, Component, Inject, forwardRef, EventEmitter } from '@angular/core';
import { VirtualizedCollection } from 'angular2-slickgrid';

import { IGridDataSet } from 'sql/parts/grid/common/interfaces';
import * as Services from 'sql/parts/grid/services/sharedServices';
import { IEditDataComponentParams } from 'sql/services/bootstrap/bootstrapParams';
import { GridParentComponent } from 'sql/parts/grid/views/gridParentComponent';
import { EditDataGridActionProvider } from 'sql/parts/grid/views/editData/editDataGridActions';
import { error } from 'sql/base/common/log';
import { clone, mixin } from 'sql/base/common/objects';
import { IQueryEditorService } from 'sql/parts/query/common/queryEditorService';
import { IBootstrapParams } from 'sql/services/bootstrap/bootstrapService';
import { RowNumberColumn } from 'sql/base/browser/ui/table/plugins/rowNumberColumn.plugin';
import { AutoColumnSize } from 'sql/base/browser/ui/table/plugins/autoSizeColumns.plugin';
import { AdditionalKeyBindings } from 'sql/base/browser/ui/table/plugins/additionalKeyBindings.plugin';
import { escape } from 'sql/base/common/strings';

import { INotificationService } from 'vs/platform/notification/common/notification';
import Severity from 'vs/base/common/severity';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IClipboardService } from 'vs/platform/clipboard/common/clipboardService';
import { KeyCode } from 'vs/base/common/keyCodes';
import { StandardKeyboardEvent } from 'vs/base/browser/keyboardEvent';
export const EDITDATA_SELECTOR: string = 'editdata-component';

@Component({
	selector: EDITDATA_SELECTOR,
	host: { '(window:keydown)': 'keyEvent($event)', '(window:gridnav)': 'keyEvent($event)' },
	templateUrl: decodeURI(require.toUrl('sql/parts/grid/views/editData/editData.component.html'))
})

export class EditDataComponent extends GridParentComponent implements OnInit, OnDestroy {
	// CONSTANTS
	private scrollTimeOutTime = 200;
	private windowSize = 50;

	// FIELDS
	// All datasets
	private dataSet: IGridDataSet;
	private scrollTimeOut: number;
	private scrollEnabled = true;
	private firstRender = true;
	private totalElapsedTimeSpan: number;
	private complete = false;

	// Current selected cell state
	private currentCell: { row: number, column: number, isEditable: boolean };
	private currentEditCellValue: string;
	private newRowVisible: boolean;
	private removingNewRow: boolean;
	private rowIdMappings: { [gridRowId: number]: number } = {};
	protected plugins = new Array<Array<Slick.Plugin<any>>>();

	// Edit Data functions
	public onActiveCellChanged: (event: Slick.OnActiveCellChangedEventArgs<any>) => void;
	public onCellEditEnd: (event: Slick.OnCellChangeEventArgs<any>) => void;
	public onIsCellEditValid: (row: number, column: number, newValue: any) => boolean;
	public onIsColumnEditable: (column: number) => boolean;
	public overrideCellFn: (rowNumber, columnId, value?, data?) => string;
	public loadDataFunction: (offset: number, count: number) => Promise<{}[]>;

	private savedViewState: {
		gridSelections: Slick.Range[];
		scrollTop;
		scrollLeft;
	};

	constructor(
		@Inject(forwardRef(() => ElementRef)) el: ElementRef,
		@Inject(forwardRef(() => ChangeDetectorRef)) cd: ChangeDetectorRef,
		@Inject(IBootstrapParams) params: IEditDataComponentParams,
		@Inject(IInstantiationService) private instantiationService: IInstantiationService,
		@Inject(INotificationService) private notificationService: INotificationService,
		@Inject(IContextMenuService) contextMenuService: IContextMenuService,
		@Inject(IKeybindingService) keybindingService: IKeybindingService,
		@Inject(IContextKeyService) contextKeyService: IContextKeyService,
		@Inject(IConfigurationService) configurationService: IConfigurationService,
		@Inject(IClipboardService) clipboardService: IClipboardService,
		@Inject(IQueryEditorService) queryEditorService: IQueryEditorService
	) {
		super(el, cd, contextMenuService, keybindingService, contextKeyService, configurationService, clipboardService, queryEditorService);
		this._el.nativeElement.className = 'slickgridContainer';
		this.dataService = params.dataService;
		this.actionProvider = this.instantiationService.createInstance(EditDataGridActionProvider, this.dataService, this.onGridSelectAll(), this.onDeleteRow(), this.onRevertRow());
		params.onRestoreViewState(() => this.restoreViewState());
		params.onSaveViewState(() => this.saveViewState());
	}

	/**
	 * Called by Angular when the object is initialized
	 */
	ngOnInit(): void {
		const self = this;
		this.baseInit();

		// Add the subscription to the list of things to be disposed on destroy, or else on a new component init
		// may get the "destroyed" object still getting called back.
		this.subscribeWithDispose(this.dataService.queryEventObserver, (event) => {
			switch (event.type) {
				case 'start':
					self.handleStart(self, event);
					break;
				case 'complete':
					self.handleComplete(self, event);
					break;
				case 'message':
					self.handleMessage(self, event);
					break;
				case 'resultSet':
					self.handleResultSet(self, event);
					break;
				case 'editSessionReady':
					self.handleEditSessionReady(self, event);
					break;
				default:
					error('Unexpected query event type "' + event.type + '" sent');
					break;
			}
			self._cd.detectChanges();
		});

		this.dataService.onAngularLoaded();
	}

	protected initShortcuts(shortcuts: { [name: string]: Function }): void {
		// TODO add any Edit Data-specific shortcuts here
	}

	public ngOnDestroy(): void {
		this.baseDestroy();
	}

	handleStart(self: EditDataComponent, event: any): void {
		self.dataSet = undefined;
		self.placeHolderDataSets = [];
		self.renderedDataSets = self.placeHolderDataSets;
		this._cd.detectChanges();
		self.totalElapsedTimeSpan = undefined;
		self.complete = false;

		// Hooking up edit functions
		this.onIsCellEditValid = (row, column, value): boolean => {
			// TODO can only run sync code
			return true;
		};

		this.onActiveCellChanged = this.onCellSelect;

		this.onCellEditEnd = (event: Slick.OnCellChangeEventArgs<any>): void => {
			// Store the value that was set
			self.currentEditCellValue = event.item[event.cell - 1];
		};

		this.overrideCellFn = (rowNumber, columnId, value?, data?): string => {
			let returnVal = '';
			if (Services.DBCellValue.isDBCellValue(value)) {
				returnVal = value.displayValue;
			} else if (typeof value === 'string') {
				returnVal = value;
			}
			return returnVal;
		};

		// Setup a function for generating a promise to lookup result subsets
		this.loadDataFunction = (offset: number, count: number): Promise<{}[]> => {
			return new Promise<{}[]>((resolve, reject) => {
				self.dataService.getEditRows(offset, count).subscribe(result => {
					let gridData = result.subset.map(r => {
						let dataWithSchema = {};
						// skip the first column since its a number column
						for (let i = 1; i < this.dataSet.columnDefinitions.length; i++) {
							dataWithSchema[this.dataSet.columnDefinitions[i].field] = r.cells[i - 1].displayValue;
						}
						return dataWithSchema;
					});
					// let rowIndex = offset;
					// let gridData: IGridDataRow[] = result.subset.map(row => {
					// 	self.idMapping[rowIndex] = row.id;
					// 	rowIndex++;
					// 	return {
					// 		values: [{}].concat(row.cells.map(c => {
					// 			return mixin({ ariaLabel: escape(c.displayValue) }, c);
					// 		})), row: row.id
					// 	};
					// });

					// Append a NULL row to the end of gridData
					// let newLastRow = gridData.length === 0 ? 0 : (gridData[gridData.length - 1].row + 1);
					// gridData.push({ values: self.dataSet.columnDefinitions.map(cell => { return { displayValue: 'NULL', isNull: false }; }), row: newLastRow });
					resolve(gridData);
				});
			});
		};
	}

	onDeleteRow(): (index: number) => void {
		const self = this;
		return (index: number): void => {
			// If the user is deleting a new row that hasn't been committed yet then use the revert code
			if (self.newRowVisible && index === self.dataSet.dataRows.getLength() - 2) {
				self.revertCurrentRow();
			} else {
				self.dataService.deleteRow(index)
					.then(() => self.dataService.commitEdit())
					.then(() => self.removeRow(index));
			}
		};
	}

	onRevertRow(): () => void {
		const self = this;
		return (): void => {
			self.revertCurrentRow();
		};
	}

	onCellSelect(event: Slick.OnActiveCellChangedEventArgs<any>): void {
		let self = this;
		let row = event.row;
		let column = event.cell;

		// Skip processing if the newly selected cell is undefined or we don't have column
		// definition for the column (ie, the selection was reset)
		if (row === undefined || column === undefined) {
			return;
		}

		// Skip processing if the cell hasn't moved (eg, we reset focus to the previous cell after a failed update)
		if (this.currentCell.row === row && this.currentCell.column === column) {
			return;
		}

		let cellSelectTasks: Promise<void> = Promise.resolve();

		if (this.currentCell.isEditable && this.currentEditCellValue !== null && !this.removingNewRow) {
			// We're exiting a read/write cell after having changed the value, update the cell value in the service
			cellSelectTasks = cellSelectTasks.then(() => {
				// Use the mapped row ID if we're on that row
				let sessionRowId = self.rowIdMappings[self.currentCell.row] !== undefined
					? self.rowIdMappings[self.currentCell.row]
					: self.currentCell.row;

				return self.dataService.updateCell(sessionRowId, self.currentCell.column - 1, self.currentEditCellValue)
					.then(
					result => {
						// Cell update was successful, update the flags
						self.currentEditCellValue = null;
						self.setCellDirtyState(row, self.currentCell.column, result.cell.isDirty);
						self.setRowDirtyState(row, result.isRowDirty);
						return Promise.resolve();
					},
					error => {
						// Cell update failed, jump back to the last cell we were on
						self.focusCell(self.currentCell.row, self.currentCell.column, true);
						return Promise.reject(null);
					}
					);
			});
		}

		if (this.currentCell.row !== row) {
			// If we're currently adding a new row, only commit it if it has changes or the user is trying to add another new row
			if (this.newRowVisible && this.currentCell.row === this.dataSet.dataRows.getLength() - 2 && !this.isNullRow(row) && this.currentEditCellValue === null) {
				cellSelectTasks = cellSelectTasks.then(() => {
					return this.revertCurrentRow().then(() => this.focusCell(row, column));
				});
			} else {
				// We're changing row, commit the changes
				cellSelectTasks = cellSelectTasks.then(() => {
					return self.dataService.commitEdit().then(result => {
						// Committing was successful, clean the grid
						self.setGridClean();
						self.rowIdMappings = {};
						self.newRowVisible = false;
						return Promise.resolve();
					}, error => {
						// Committing failed, jump back to the last selected cell
						self.focusCell(self.currentCell.row, self.currentCell.column);
						return Promise.reject(null);
					});
				});
			}
		}

		if (this.isNullRow(row) && !this.removingNewRow) {
			// We've entered the "new row", so we need to add a row and jump to it
			cellSelectTasks = cellSelectTasks.then(() => {
				self.addRow(row);
			});
		}

		// At the end of a successful cell select, update the currently selected cell
		cellSelectTasks = cellSelectTasks.then(() => {
			self.currentCell = {
				row: row,
				column: column,
				isEditable: self.dataSet.columnDefinitions[column]
					? self.dataSet.columnDefinitions[column].isEditable
					: false
			};
		});

		// Cap off any failed promises, since they'll be handled
		cellSelectTasks.catch(() => { });
	}

	handleComplete(self: EditDataComponent, event: any): void {
		self.totalElapsedTimeSpan = event.data;
		self.complete = true;
	}

	handleEditSessionReady(self, event): void {
		// TODO: update when edit session is ready
	}

	handleMessage(self: EditDataComponent, event: any): void {
		if (event.data && event.data.isError) {
			self.notificationService.notify({
				severity: Severity.Error,
				message: event.data.message
			});
		}
	}

	handleResultSet(self: EditDataComponent, event: any): void {
		// Clone the data before altering it to avoid impacting other subscribers
		let resultSet = Object.assign({}, event.data);

		// Add an extra 'new row'
		resultSet.rowCount++;
		// Precalculate the max height and min height
		let maxHeight = this.getMaxHeight(resultSet.rowCount);
		let minHeight = this.getMinHeight(resultSet.rowCount);

		let rowNumberColumn = new RowNumberColumn({ numberOfRows: resultSet.rowCount });

		// Store the result set from the event
		let dataSet: IGridDataSet = {
			resized: undefined,
			batchId: resultSet.batchId,
			resultId: resultSet.id,
			totalRows: resultSet.rowCount,
			maxHeight: maxHeight,
			minHeight: minHeight,
			dataRows: new VirtualizedCollection(
				self.windowSize,
				resultSet.rowCount,
				this.loadDataFunction,
				index => { return {}; }
			),
			columnDefinitions: [rowNumberColumn.getColumnDefinition()].concat(resultSet.columnInfo.map((c, i) => {
				let isLinked = c.isXml || c.isJson;
				let linkType = c.isXml ? 'xml' : 'json';

				return {
					id: i.toString(),
					name: c.columnName === 'Microsoft SQL Server 2005 XML Showplan'
						? 'XML Showplan'
						: escape(c.columnName),
					field: i.toString(),
					formatter: isLinked ? Services.hyperLinkFormatter : Services.textFormatter,
					asyncPostRender: isLinked ? self.linkHandler(linkType) : undefined,
					isEditable: c.isUpdatable
				};
			}))
		};
		self.plugins.push([rowNumberColumn, new AutoColumnSize(), new AdditionalKeyBindings()]);
		self.dataSet = dataSet;

		// Create a dataSet to render without rows to reduce DOM size
		let undefinedDataSet = clone(dataSet);
		undefinedDataSet.columnDefinitions = dataSet.columnDefinitions;
		undefinedDataSet.dataRows = undefined;
		undefinedDataSet.resized = new EventEmitter();
		self.placeHolderDataSets.push(undefinedDataSet);
		self.onScroll(0);

		// Setup the state of the selected cell
		this.currentCell = { row: null, column: null, isEditable: null };
		this.currentEditCellValue = null;
		this.removingNewRow = false;
		this.newRowVisible = false;
	}

	/**
	 * Handles rendering the results to the DOM that are currently being shown
	 * and destroying any results that have moved out of view
	 * @param scrollTop The scrolltop value, if not called by the scroll event should be 0
	 */
	onScroll(scrollTop): void {
		const self = this;
		clearTimeout(self.scrollTimeOut);
		this.scrollTimeOut = setTimeout(() => {
			self.scrollEnabled = false;
			for (let i = 0; i < self.placeHolderDataSets.length; i++) {
				self.placeHolderDataSets[i].dataRows = self.dataSet.dataRows;
				self.placeHolderDataSets[i].resized.emit();
			}

			self._cd.detectChanges();

			if (self.firstRender) {
				let setActive = function () {
					if (self.firstRender && self.slickgrids.toArray().length > 0) {
						self.slickgrids.toArray()[0].setActive();
						self.firstRender = false;
					}
				};

				setTimeout(() => {
					setActive();
				});
			}
		}, self.scrollTimeOutTime);
	}

	protected tryHandleKeyEvent(e: StandardKeyboardEvent): boolean {
		let handled: boolean = false;
		// If the esc key was pressed while in a create session
		let currentNewRowIndex = this.dataSet.totalRows - 2;

		if (e.keyCode === KeyCode.Escape) {
			this.revertCurrentRow();
			handled = true;
		}
		return handled;
	}

	// Private Helper Functions ////////////////////////////////////////////////////////////////////////////

	private async revertCurrentRow(): Promise<void> {
		let currentNewRowIndex = this.dataSet.totalRows - 2;
		if (this.newRowVisible && this.currentCell.row === currentNewRowIndex) {
			// revert our last new row
			this.removingNewRow = true;

			this.dataService.revertRow(this.rowIdMappings[currentNewRowIndex])
				.then(() => {
					this.removeRow(currentNewRowIndex);
					this.newRowVisible = false;
				});
		} else {
			try {
				// Perform a revert row operation
				if (this.currentCell) {
					await this.dataService.revertRow(this.currentCell.row);
				}
			} finally {
				// The operation may fail if there were no changes sent to the service to revert,
				// so clear any existing client-side edit and refresh on-screen data
				// do not refresh the whole dataset as it will move the focus away to the first row.
				//
				this.currentEditCellValue = null;
				this.dataSet.dataRows.resetWindowsAroundIndex(this.currentCell.row);
			}
		}
	}

	// Checks if input row is our NULL new row
	private isNullRow(row: number): boolean {
		// Null row is always at index (totalRows - 1)
		return (row === this.dataSet.totalRows - 1);
	}

	// Adds CSS classes to slickgrid cells to indicate a dirty state
	private setCellDirtyState(row: number, column: number, dirtyState: boolean): void {
		let slick: any = this.slickgrids.toArray()[0];
		let grid = slick._grid;
		if (dirtyState) {
			// Change cell color
			$(grid.getCellNode(row, column)).addClass('dirtyCell').removeClass('selected');
		} else {
			$(grid.getCellNode(row, column)).removeClass('dirtyCell');
		}
	}

	// Adds CSS classes to slickgrid rows to indicate a dirty state
	private setRowDirtyState(row: number, dirtyState: boolean): void {
		let slick: any = this.slickgrids.toArray()[0];
		let grid = slick._grid;
		if (dirtyState) {
			// Change row header color
			$(grid.getCellNode(row, 0)).addClass('dirtyRowHeader');
		} else {
			$(grid.getCellNode(row, 0)).removeClass('dirtyRowHeader');
		}
	}

	// Sets CSS to clean the entire grid of dirty state cells and rows
	private setGridClean(): void {
		// Remove dirty classes from the entire table
		let allRows = $($('.grid-canvas').children());
		let allCells = $(allRows.children());
		allCells.removeClass('dirtyCell').removeClass('dirtyRowHeader');
	}

	// Adds an extra row to the end of slickgrid (just for rendering purposes)
	// Then sets the focused call afterwards
	private addRow(row: number): void {
		let self = this;

		// Add a new row to the edit session in the tools service
		this.dataService.createRow()
			.then(result => {
				// Map the new row ID to the row ID we have
				self.rowIdMappings[row] = result.newRowId;
				self.newRowVisible = true;

				// Add a new "new row" to the end of the results
				// Adding an extra row for 'new row' functionality
				self.dataSet.totalRows++;
				self.dataSet.maxHeight = self.getMaxHeight(this.dataSet.totalRows);
				self.dataSet.minHeight = self.getMinHeight(this.dataSet.totalRows);
				self.dataSet.dataRows = new VirtualizedCollection(
					self.windowSize,
					self.dataSet.totalRows,
					self.loadDataFunction,
					index => { return { values: [] }; }
				);

				// Refresh grid
				self.onScroll(0);

				// Mark the row as dirty once the scroll has completed
				setTimeout(() => {
					self.setRowDirtyState(row, true);
				}, self.scrollTimeOutTime);
			});
	}

	// removes a row from the end of slickgrid (just for rendering purposes)
	// Then sets the focused call afterwards
	private removeRow(row: number): void {
		// Removing the new row
		this.dataSet.totalRows--;
		this.dataSet.dataRows = new VirtualizedCollection(
			this.windowSize,
			this.dataSet.totalRows,
			this.loadDataFunction,
			index => { return { values: [] }; }
		);

		// refresh results view
		this.onScroll(0);

		// Set focus to the row index column of the removed row if the current selection is in the removed row
		setTimeout(() => {
			if (this.currentCell.row === row) {
				this.focusCell(row, 0);
			}
			this.removingNewRow = false;
		}, this.scrollTimeOutTime);
	}

	private focusCell(row: number, column: number, forceEdit: boolean = true): void {
		let slick: any = this.slickgrids.toArray()[0];
		let grid = slick._grid;
		grid.gotoCell(row, column, forceEdit);
	}

	private getMaxHeight(rowCount: number): any {
		return rowCount < this._defaultNumShowingRows
			? ((rowCount + 1) * this._rowHeight) + 10
			: 'inherit';
	}

	private getMinHeight(rowCount: number): any {
		return rowCount > this._defaultNumShowingRows
			? (this._defaultNumShowingRows + 1) * this._rowHeight + 10
			: this.getMaxHeight(rowCount);
	}

	private saveViewState(): void {
		let grid = this.slickgrids.toArray()[0]
		if (grid) {
			let gridSelections = grid.getSelectedRanges();
			let viewport = ((grid as any)._grid.getCanvasNode() as HTMLElement).parentElement;

			this.savedViewState = {
				gridSelections,
				scrollTop: viewport.scrollTop,
				scrollLeft: viewport.scrollLeft
			};
		}
	}

	private restoreViewState(): void {
		if (this.savedViewState) {
			this.slickgrids.toArray()[0].selection = this.savedViewState.gridSelections;
			let viewport = ((this.slickgrids.toArray()[0] as any)._grid.getCanvasNode() as HTMLElement).parentElement;
			viewport.scrollLeft = this.savedViewState.scrollLeft;
			viewport.scrollTop = this.savedViewState.scrollTop;
			this.savedViewState = undefined;
		}
	}
}
