import { Ellipsis } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Btn } from './ui';

type MenuAction={label:string;onSelect:()=>void;danger?:boolean;disabled?:boolean};
export function ActionMenu({label,items,disabled=false,iconOnly=false}: {label:string;items:MenuAction[];disabled?:boolean;iconOnly?:boolean}) {
  return <DropdownMenu><DropdownMenuTrigger asChild><Btn tone="quiet" className={'sv-more-trigger'+(iconOnly?' sv-icon-button':'')} disabled={disabled} aria-label={label}><Ellipsis size={20}/>{iconOnly?null:label}</Btn></DropdownMenuTrigger><DropdownMenuContent className="sv-action-menu" align="end" collisionPadding={16}>
    {items.map(item=><DropdownMenuItem key={item.label} variant={item.danger?'destructive':'default'} disabled={item.disabled} onSelect={item.onSelect}>{item.label}</DropdownMenuItem>)}
  </DropdownMenuContent></DropdownMenu>;
}
