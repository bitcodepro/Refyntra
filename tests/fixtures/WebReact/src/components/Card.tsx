import { Component } from 'react';

export class Card extends Component<{ title: string }> {
  render() {
    return <section>{this.props.title}</section>;
  }
}
