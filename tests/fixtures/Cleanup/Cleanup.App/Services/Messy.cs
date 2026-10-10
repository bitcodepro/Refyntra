using System.Text;
using System.Linq;
using System;
using Cleanup.App.Models;

namespace Cleanup.App.Services
{
    public sealed class Messy   
    {
        public int Count(int[] xs) => xs.Count();	

        public Customer Make() => new Customer("a");
    }
}