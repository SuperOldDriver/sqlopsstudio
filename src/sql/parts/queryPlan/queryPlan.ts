/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as QP from 'html-query-plan';

import { IPanelView, IPanelTab } from 'sql/base/browser/ui/panel/panel';

import { Dimension } from 'vs/base/browser/dom';
import { localize } from 'vs/nls';
import * as UUID from 'vs/base/common/uuid';
import { Builder } from 'vs/base/browser/builder';

export class QueryPlanTab implements IPanelTab {
	public readonly title = localize('resultsTabTitle', 'Results');
	public readonly identifier = UUID.generateUuid();
	public readonly view: QueryPlanView;

	constructor() {
		this.view = new QueryPlanView();
	}
}


export class QueryPlanView implements IPanelView {
	private qp: QueryPlan;

	public render(container: HTMLElement): void {
		this.qp = new QueryPlan(container);
	}

	public layout(dimension: Dimension): void {
	}
}

export class QueryPlan {
	private _xml: string;
	constructor(private container: HTMLElement) {

	}

	public set xml(xml: string) {
		this._xml = xml;
		new Builder(this.container).empty();
		QP.showPlan(this.container, this._xml, {
			jsTooltips: false
		});
	}

	public get xml(): string {
		return this._xml;
	}
}