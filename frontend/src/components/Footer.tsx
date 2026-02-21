export function Footer() {
    return (
        <div className="flex items-center gap-10 px-10 py-[18px] border-t border-gray-200 bg-[rgba(245,245,245,0.7)]">
            <span className="text-[0.65rem] font-semibold tracking-widest text-gray-400 uppercase whitespace-nowrap">
                Powering Strategy At
            </span>
            <div className="flex gap-8 flex-1">
                {["CHAINALYSIS", "Elliptic", "TRM Labs", "Nansen", "Dune"].map((name) => (
                    <span key={name} className="text-[0.8rem] font-semibold tracking-wide text-gray-400 hover:text-gray-500 transition-colors cursor-default">
                        {name}
                    </span>
                ))}
            </div>
            <div className="flex items-center gap-2 text-[0.75rem] text-gray-400 whitespace-nowrap">
                <span className="inline-flex items-center justify-center w-5 h-5 bg-gray-900 text-white text-[0.65rem] font-bold rounded-[4px]">
                    A
                </span>
                Made in Aura
            </div>
        </div>
    );
}
