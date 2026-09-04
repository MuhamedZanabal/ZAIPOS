import { Card } from "@/components/ui/card";
import { Construction } from "lucide-react";

export default function Stub({ title, description }: { title: string; description: string }) {
  return (
    <div className="p-6">
      <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
      <p className="text-muted-foreground text-sm mb-4">{description}</p>
      <Card className="p-12 text-center">
        <Construction className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
        <h2 className="font-semibold">Module in preparation</h2>
        <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
          The tables and security rules are already ready in the backend. This screen will be completed in the next iteration.
        </p>
      </Card>
    </div>
  );
}
