export default function Inbox() {
  return (
    <div className="flex h-full">
      {/* Column 1: Conversations List */}
      <div className="w-80 border-r bg-card flex flex-col">
        <div className="p-4 border-b">
          <input type="text" placeholder="Search conversations..." className="w-full h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm" />
        </div>
        <div className="flex-1 overflow-auto p-2">
          {[1,2,3,4,5].map(i => (
            <div key={i} className="p-3 mb-2 rounded-lg cursor-pointer hover:bg-accent hover:text-accent-foreground border border-transparent">
              <div className="flex justify-between items-center mb-1">
                <span className="font-semibold text-sm">Customer {i}</span>
                <span className="text-xs text-muted-foreground">10:42 AM</span>
              </div>
              <p className="text-xs text-muted-foreground truncate">I would like to know more about the product.</p>
            </div>
          ))}
        </div>
      </div>

      {/* Column 2: Chat Thread */}
      <div className="flex-1 flex flex-col bg-background">
        <div className="h-16 border-b flex items-center px-6 bg-card shrink-0">
          <h2 className="font-semibold">Customer 1</h2>
          <span className="ml-3 px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 text-xs font-medium">Instagram</span>
        </div>
        <div className="flex-1 p-6 overflow-auto">
          <div className="flex flex-col space-y-4">
            <div className="flex items-start">
              <div className="w-8 h-8 rounded-full bg-accent flex items-center justify-center mr-3 shrink-0">C</div>
              <div className="bg-muted p-3 rounded-2xl rounded-tl-sm text-sm">
                Hello, do you deliver to Oran?
              </div>
            </div>
            <div className="flex items-start flex-row-reverse">
              <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center ml-3 shrink-0 text-primary">A</div>
              <div className="bg-primary text-primary-foreground p-3 rounded-2xl rounded-tr-sm text-sm">
                Yes, we do! Delivery to Oran usually takes 2-3 business days.
              </div>
            </div>
          </div>
        </div>
        <div className="p-4 border-t bg-card shrink-0">
          <div className="flex gap-2">
            <input type="text" placeholder="Type a message or use AI to reply..." className="flex-1 h-10 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm" />
            <button className="h-10 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90">Send</button>
          </div>
        </div>
      </div>

      {/* Column 3: Context & AI Panel */}
      <div className="w-80 border-l bg-card flex flex-col overflow-auto">
        <div className="p-6 border-b">
          <div className="flex flex-col items-center mb-4">
            <div className="w-20 h-20 rounded-full bg-accent flex items-center justify-center text-2xl mb-3">C1</div>
            <h3 className="font-semibold text-lg">Customer 1</h3>
            <p className="text-sm text-muted-foreground">Oran, Algeria</p>
          </div>
          <div className="flex flex-wrap gap-2 justify-center">
            <span className="px-2 py-1 rounded-md bg-secondary text-secondary-foreground text-xs font-medium">VIP</span>
            <span className="px-2 py-1 rounded-md bg-secondary text-secondary-foreground text-xs font-medium">Interested</span>
          </div>
        </div>
        <div className="p-6">
          <h4 className="font-semibold text-sm mb-3 uppercase tracking-wider text-muted-foreground">AI Intent Detected</h4>
          <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 mb-4">
            <p className="text-sm font-medium text-primary mb-1">Logistics Inquiry</p>
            <p className="text-xs text-muted-foreground">Customer is asking about delivery locations and times.</p>
          </div>
          <button className="w-full h-9 rounded-md bg-accent text-accent-foreground text-sm font-medium hover:bg-accent/80 border border-input">
            Generate AI Reply
          </button>
        </div>
      </div>
    </div>
  );
}

