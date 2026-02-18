import { useEffect, useMemo, useRef } from "react";

type ThoughtPanelProps = {
	player: "A" | "B";
	thoughts: string[];
	isThinking: boolean;
};

export function ThoughtPanel({
	player,
	thoughts,
	isThinking,
}: ThoughtPanelProps) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const thoughtItems = useMemo(() => {
		const counts = new Map<string, number>();
		return thoughts.map((text) => {
			const count = (counts.get(text) ?? 0) + 1;
			counts.set(text, count);
			return {
				text,
				key: `t-${player}-${text}-${count}`,
			};
		});
	}, [player, thoughts]);

	const thoughtCount = thoughts.length;
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new thoughts
	useEffect(() => {
		scrollRef.current?.scrollTo({
			top: scrollRef.current.scrollHeight,
			behavior: "smooth",
		});
	}, [thoughtCount]);

	return (
		<div
			className={`thought-panel thought-panel-${player === "A" ? "left" : "right"}`}
		>
			<div
				className={`thought-panel-label player-${player.toLowerCase()}-color`}
			>
				PLAYER {player}
			</div>
			<div className="thought-panel-content" ref={scrollRef}>
				{thoughts.length === 0 ? (
					<div className="thought-placeholder">
						Awaiting agent connection...
					</div>
				) : (
					thoughtItems.map(({ text, key }) => (
						<div
							key={key}
							className={`thought-line player-${player.toLowerCase()}-color`}
						>
							{text}
						</div>
					))
				)}
				{isThinking ? <span className="thought-cursor">_</span> : null}
			</div>
		</div>
	);
}
