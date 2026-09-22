import { Container, Spacer, Text } from "@earendil-works/pi-tui";

/**
 * One startup banner section (`[Skills]`, `[Extensions]`, ...) with a collapsed and an expanded body.
 * A section whose collapsed body is empty renders nothing until it is expanded, so a banner that
 * would only list system resources disappears from the compact view without leaving a blank gap.
 */
export class LoadedResourceSection extends Container {
	private readonly body = new Text("", 0, 0);
	private readonly collapsedText: string;
	private readonly expandedText: string;

	constructor(collapsedText: string, expandedText: string, expanded: boolean) {
		super();
		this.collapsedText = collapsedText;
		this.expandedText = expandedText;
		this.setExpanded(expanded);
	}

	setExpanded(expanded: boolean): void {
		const text = expanded ? this.expandedText : this.collapsedText;
		this.clear();
		if (text.length === 0) return;
		this.body.setText(text);
		this.addChild(this.body);
		this.addChild(new Spacer(1));
	}
}
