import { DotCube } from "./DotCube";

export function Background({
    children,
    className,
    useDotCube,
}: {
    children: React.ReactNode;
    className?: string;
    useDotCube?: boolean;
}) {
    return (
        <div
            className={
                className ||
                "min-h-[calc(100vh-115px)] flex flex-col items-center justify-center px-4 font-[Outfit,Inter,sans-serif] relative overflow-hidden"
            }
            style={{
                backgroundColor: "#f5f5f5",
                backgroundImage:
                    "linear-gradient(#e2e2e2 1px, transparent 1px), linear-gradient(90deg, #e2e2e2 1px, transparent 1px)",
                backgroundSize: "20px 20px",
            }}
        >
            {/* Background elements */}
            {useDotCube && (
                <>
                    <DotCube className="absolute top-10 -left-10 w-[600px] h-[500px] opacity-60 pointer-events-none" />
                    <DotCube className="absolute -bottom-20 -right-20 w-[600px] h-[500px] opacity-60 pointer-events-none" />
                </>
            )}
            {children}
        </div>
    );
}
