using Refactorings.Lib.ChangeSignature;
using Refactorings.Lib.SafeDelete;

var members = new Members();
members.UsedMethod();
Console.WriteLine(members.UsedField);
Console.WriteLine(new LoudGreeter().Greet("app", 1));
Console.WriteLine(new Point(4, 5).X);
Console.WriteLine(Refactorings.Lib.EditActions.Pricing.WithTax(10m));
