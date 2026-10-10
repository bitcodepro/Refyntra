using Renames.Lib;
using W = Renames.Lib.Widget;

var w = new W();
w.Run(1);
w.Run("one");
Console.WriteLine(nameof(Widget) + " " + nameof(W) + " " + w.Describe());
var g = new Gadget { Size = 2 }.Twice();
Console.WriteLine(g.Size);
