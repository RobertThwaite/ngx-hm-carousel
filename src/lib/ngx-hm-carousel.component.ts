import { isPlatformBrowser } from '@angular/common';
import {
  AfterContentInit,
  AfterViewInit,
  Component,
  ContentChild,
  ContentChildren,
  ElementRef,
  Inject,
  Input,
  OnDestroy,
  PLATFORM_ID,
  QueryList,
  Renderer2,
  TemplateRef,
  ViewChild,
  forwardRef,
} from '@angular/core';
import { BehaviorSubject, Observable, fromEvent, interval, merge, Subject, Subscription } from 'rxjs';
import { bufferCount, debounceTime, switchMap, takeUntil, tap } from 'rxjs/operators';

import { NgxHmCarouselItemDirective } from './ngx-hm-carousel-item.directive';
import { resizeObservable } from './rxjs.observable.resize';
import { NG_VALUE_ACCESSOR, ControlValueAccessor } from '@angular/forms';

// if the pane is paned .25, switch to the next pane.
const PANBOUNDARY = 0.15;

const EXE_COUNTER_VALUE_ACCESSOR: any = {
  provide: NG_VALUE_ACCESSOR,
  useExisting: forwardRef(() => NgxHmCarouselComponent),
  multi: true
};

@Component({
  selector: 'ngx-hm-carousel',
  templateUrl: './ngx-hm-carousel.component.html',
  styleUrls: ['./ngx-hm-carousel.component.scss'],
  providers: [EXE_COUNTER_VALUE_ACCESSOR],
})
export class NgxHmCarouselComponent implements ControlValueAccessor, AfterViewInit, AfterContentInit, OnDestroy {
  @ViewChild('parentChild') parentChild;
  @ViewChild('prev') private btnPrev: ElementRef;
  @ViewChild('next') private btnNext: ElementRef;
  @ContentChildren(NgxHmCarouselItemDirective) items: QueryList<NgxHmCarouselItemDirective>;
  @ContentChild('carouselPrev') contentPrev: TemplateRef<any>;
  @ContentChild('carouselNext') contentNext: TemplateRef<any>;
  @ContentChild('carouselDot') dotElm: TemplateRef<any>;
  @ContentChild('carouselProgress') progressElm: TemplateRef<any>;

  @Input('aniTime') aniTime = 400;
  @Input('align') align: 'left' | 'center' | 'right' = 'center';
  @Input('infinite')
  set infinite(value) {
    this._infinite = value;
    if (this.LatestElm_clone) {
      this.addStyle(this.LatestElm_clone, {
        visibility: this.runLoop ? 'visible' : 'hidden'
      });
    }
    if (this.firstElm_clone) {
      this.addStyle(this.firstElm_clone, {
        visibility: this.runLoop ? 'visible' : 'hidden'
      });
    }
  }
  get infinite() {
    return this._infinite;
  }
  @Input('mourse-enable') mourseEnable = false;
  @Input('autoplay-speed') speed = 5000;
  @Input('between-delay') delay = 8000;
  @Input('autoplay-direction') direction: 'left' | 'right' = 'right';
  @Input('show-num')
  set showNum(value: number | 'auto') {
    if (value === 'auto') {
      this.isAutoNum = true;
    } else {
      this._showNum = value;
    }
  }
  get showNum() {
    return this._showNum;
  }
  @Input('scroll-num') scrollNum = 1;
  @Input('drag-many') isDragMany = false;

  set currentIndex(value) {
    // if now index if not equale to save index, do someting
    if (this.currentIndex !== value) {
      this._currentIndex = value;
      if (this.itemsElm) {
        if (this.autoplay && !this.isFromAuto) {
          this.stopEvent.next();
          this.restart.next(null);
        }
        this.drawView(this.currentIndex);
      }
      if (0 <= this.currentIndex && this.currentIndex <= this.lastIndex) {
        this.onChange(this.currentIndex);
      }
    }
    this.isFromAuto = false;
  }
  get currentIndex() {
    return this._currentIndex;
  }

  @Input('autoplay')
  set autoplay(value) {
    if (isPlatformBrowser(this.platformId)) {
      if (this.itemsElm) {
        this.progressWidth = 0;
        if (value) {
          this.doNextSub$ = this.doNext.subscribe();
        } else {
          if (this.doNextSub$) { this.doNextSub$.unsubscribe(); }
        }
      }
    }
    this._autoplay = value;
    // if set autoplay, then the infinite is true
    if (this.autoplay) {
      this.infinite = true;
    }
  }
  get autoplay() {
    return this._autoplay;
  }

  set progressWidth(value) {
    if (this.progressElm !== undefined && this.autoplay) {
      this._porgressWidth = value;
    }
  }
  get progressWidth() {
    return this._porgressWidth;
  }

  get runLoop() {
    return this.autoplay || this.infinite;
  }

  get maxRightIndex() {
    let addIndex = 0;
    switch (this.align) {
      case 'left':
        addIndex = 0;
        break;
      case 'center':
        addIndex = <number>this.showNum - 1;
        break;
      case 'right':
        addIndex = <number>this.showNum - 1;
        break;
    }
    return (this.lastIndex - this._showNum + 1) + addIndex;
  }

  private isFromAuto = true;
  private _currentIndex = 0;
  private _infinite = false;
  private _showNum = 1;
  private isAutoNum = false;
  private _autoplay = false;
  private _porgressWidth = 0;

  private rootElm: HTMLElement;
  private alignDistance = 0;
  private containerElm: HTMLElement;
  private itemsElm: Array<HTMLElement>;
  private lastIndex = 0;
  private hammer: HammerManager;
  private elmWidth = 0;
  private container_left = 0;

  private mouseOnContainer = false;
  private restart = new BehaviorSubject<any>(null);
  private stopEvent = new Subject<any>();

  private doNext: Observable<any>;
  private doNextSub$: Subscription;
  private elmSub$: Subscription;

  private firstElm_clone;
  private LatestElm_clone;
  private prePanMove: boolean;
  public dots: Array<number>;
  private nextListener: () => void;
  private prevListener: () => void;

  constructor(
    @Inject(PLATFORM_ID) private platformId: Object,
    private _renderer: Renderer2) { }

  ngAfterContentInit(): void {
    this.initVariable();
  }

  ngAfterViewInit() {
    this.setViewWidth(true);
    this.reSetVariable();
    this.hammer = this.bindHammer();
    this.drawView(this.currentIndex);
    this.bindClick();

    this.addInfiniteElm();

    this.elmSub$ = resizeObservable(this.rootElm, () => this.containerResize()).subscribe();
  }


  ngOnDestroy() {
    if (this.btnNext && this.btnPrev) {
      this.nextListener();
      this.prevListener();
    }
    this.hammer.destroy();
    if (this.autoplay) {
      this.doNextSub$.unsubscribe();
    }

    this.elmSub$.unsubscribe();
  }

  setIndex(i) {
    this.currentIndex = i;
  }

  writeValue(value: any) { if (value || value === 0) { this.currentIndex = value; } }
  registerOnChange(fn: (value: any) => any) { this.onChange = fn; }
  registerOnTouched(fn: () => any) { this.onTouched = fn; }
  private onChange = (_: any) => { };
  private onTouched = () => { };

  private addInfiniteElm() {
    this.firstElm_clone = this.itemsElm[this.lastIndex].cloneNode(true) as HTMLElement;
    this.addStyle(this.firstElm_clone, {
      position: 'absolute',
      transform: 'translateX(-100%)',
      visibility: this.runLoop ? 'visible' : 'hidden'
    });


    this.LatestElm_clone = this.itemsElm[0].cloneNode(true) as HTMLElement;
    this.addStyle(this.LatestElm_clone, {
      position: 'absolute',
      right: 0,
      top: 0,
      transform: 'translateX(100%)',
      visibility: this.runLoop ? 'visible' : 'hidden'
    });


    this._renderer.insertBefore(this.containerElm, this.firstElm_clone, this.itemsElm[0]);
    this._renderer.appendChild(this.containerElm, this.LatestElm_clone);
  }

  private containerResize() {
    this.reSetVariable();
    this.setViewWidth();

    // 因為不能滑了，所以要回到第一個，以確保全部都有顯示
    if (this.showNum >= this.itemsElm.length) {
      this.currentIndex = 0;
    }
    this.drawView(this.currentIndex, false);
  }

  private initVariable() {
    this.rootElm = this.parentChild.nativeElement;
    this.containerElm = this.rootElm.children[0] as HTMLElement;
    this.itemsElm = Array.from(this.containerElm.children) as HTMLElement[];
    this.lastIndex = this.itemsElm.length - 1;

    if (this.dotElm) {
      this.dots = new Array(this.itemsElm.length);
    }

    let startEvent = this.restart.asObservable();
    let stopEvent = this.stopEvent.asObservable();
    if (this.mourseEnable) {
      startEvent = merge(
        startEvent,
        fromEvent(this.containerElm, 'mouseleave').pipe(
          tap(() => this.mouseOnContainer = false)
        )
      );
      stopEvent = merge(
        stopEvent,
        fromEvent(this.containerElm, 'mouseover').pipe(
          tap(() => this.mouseOnContainer = true)
        )
      );
    }

    this.doNext = startEvent.pipe(
      debounceTime(this.delay),
      switchMap(() =>
        this.runProgress(20).pipe(
          tap(() => {
            this.isFromAuto = true;
            // console.log('next');
            if (this.direction === 'left') {
              this.currentIndex -= this.scrollNum;
            } else {
              this.currentIndex += this.scrollNum;
            }
          }),
          takeUntil(stopEvent.pipe(tap(() => this.progressWidth = 0))
          )
        )
      ));

    if (this.autoplay) {
      this.doNextSub$ = this.doNext.subscribe();
    }
  }

  private reSetVariable() {
    this.container_left = this.rootElm.getBoundingClientRect().left;
    if (this.showNum && this.showNum !== 1) {
      switch (this.align) {
        case 'center':
          this.alignDistance = (this.rootElm.clientWidth - this.elmWidth) / 2;
          break;
        case 'left':
          this.alignDistance = 0;
          break;
        case 'right':
          this.alignDistance = this.rootElm.clientWidth - this.elmWidth;
          break;
      }
    }
  }

  private setViewWidth(isInit?: boolean) {
    if (this.isAutoNum) {
      this._showNum = this.getAutoNum();
    }
    this._renderer.addClass(this.containerElm, 'grab');
    // when init check view has scroll bar
    const totalWidth = 0;
    if (isInit) {
      // remain one elm height
      this._renderer.addClass(this.containerElm, 'ngx-hm-carousel-display-npwrap');
    }
    this.elmWidth = (totalWidth + this.rootElm.clientWidth) / this._showNum;

    this._renderer.removeClass(this.containerElm, 'ngx-hm-carousel-display-npwrap');
    this._renderer.setStyle(this.containerElm, 'width', `${this.elmWidth * this.itemsElm.length}px`);
    this._renderer.setStyle(this.containerElm, 'position', 'relative');
    this.itemsElm.forEach((elm: HTMLElement, index) => {
      this._renderer.setStyle(elm, 'width', `${this.elmWidth}px`);
    });

    if (this.firstElm_clone) {
      this._renderer.setStyle(this.firstElm_clone, 'width', `${this.elmWidth}px`);
      this._renderer.setStyle(this.LatestElm_clone, 'width', `${this.elmWidth}px`);
    }
  }

  private bindHammer() {
    const hm = new Hammer(this.containerElm);
    hm.get('pan').set({ direction: Hammer.DIRECTION_HORIZONTAL });

    hm.on('panleft panright panend tap', (e: HammerInput) => {
      this._renderer.removeClass(this.containerElm, 'transition');
      this._renderer.addClass(this.containerElm, 'grabbing');

      if (this.autoplay) { this.stopEvent.next(); }

      switch (e.type) {
        case 'tap':
          this.callClick(e.center.x);
          this.callRestart();
          this._renderer.removeClass(this.containerElm, 'grabbing');
          break;
        case 'panleft':
        case 'panright':

          // 顯示總數量小於總數量，停止滑動
          if (this.showNum >= this.itemsElm.length) {
            this.hammer.stop(true);
            return;
          }
          // console.log(e.deltaY);
          this.prePanMove = false;
          if (Math.abs(e.deltaY) > 50) { return; }
          // Slow down at the first and last pane.
          if (!this.runLoop && this.outOfBound(e.type)) {
            e.deltaX *= 0.2;
          }

          this._renderer.setStyle(this.containerElm, 'left', `${-this.currentIndex * this.elmWidth + this.alignDistance + e.deltaX}px`);

          if (!this.isDragMany) {
            if (Math.abs(e.deltaX) > this.elmWidth * 0.5) {
              if (e.deltaX > 0) {
                this.currentIndex -= this.scrollNum;
              } else {
                this.currentIndex += this.scrollNum;
              }
              this._renderer.removeClass(this.containerElm, 'grabbing');
              this.callRestart();
              this.hammer.stop(true);
              // remember prv action, to avoid hammer stop, then click
              this.prePanMove = true;
            }
          }
          break;
        case 'panend':
          this.callRestart();

          this._renderer.removeClass(this.containerElm, 'grabbing');
          if (Math.abs(e.deltaX) > this.elmWidth * PANBOUNDARY) {
            const moveNum = this.isDragMany ?
              Math.ceil(Math.abs(e.deltaX) / this.elmWidth) : this.scrollNum;

            let prevIndex = this.currentIndex - moveNum;
            let nextIndex = this.currentIndex + moveNum;

            // 如果不是無限循環，不能大於或小於

            if (e.deltaX > 0) {
              if (!this.runLoop && prevIndex < 0) {
                prevIndex = 0;
                this.drawView(0);
              }

              this.currentIndex = prevIndex;
            } else {
              if (!this.runLoop && nextIndex > this.maxRightIndex) {
                nextIndex = this.maxRightIndex;
                this.drawView(nextIndex);
              }
              this.currentIndex = nextIndex;
            }
            break;
          } else {
            if (!this.isDragMany && this.prePanMove) {
              this.callClick(e.center.x);
            }
          }
          // console.log(this.currentIndex);
          this.drawView(this.currentIndex);
          this.prePanMove = false;
          break;
      }
    });

    return hm;
  }

  private bindClick() {
    if (this.btnNext && this.btnPrev) {
      this.nextListener = this._renderer.listen(this.btnNext.nativeElement, 'click', () => {
        this.currentIndex++;
      });
      this.prevListener = this._renderer.listen(this.btnPrev.nativeElement, 'click', () => {
        this.currentIndex--;
      });
    }
  }

  private callRestart() {
    if (this.autoplay && !this.mouseOnContainer) {
      this.restart.next(null);
    }
  }

  private callClick(positionX) {
    // click position subtract the containerlef and alignDistance is the move distance
    const toIndex = this.currentIndex + Math.floor((positionX - this.container_left - this.alignDistance) / this.elmWidth);

    const elm = this.items.toArray()[toIndex];
    if (elm) {
      elm.clickEvent.emit(toIndex);
    }
  }

  private drawView(index: number, isAnimation = true) {

    // move element only on length is more than 1
    if (this.itemsElm.length > 1) {
      const leftDistance = (index * this.elmWidth) - this.alignDistance;

      this._renderer.setStyle(this.containerElm, 'left', `${-leftDistance}px`);
      if (isAnimation) {
        this._renderer.addClass(this.containerElm, 'transition');
      } else {
        this._renderer.removeClass(this.containerElm, 'transition');
      }

      // 如果是循環的，當動畫結束偷偷的跳到當前的index、left去
      this.InfiniteHandler(index);
    } else {
      this._renderer.setStyle(this.containerElm, 'left', `${this.alignDistance}px`);
    }

  }

  private InfiniteHandler(index: number) {
    if (this.runLoop) {
      let state = 0;
      state = (index < 0) ? -1 : state;
      state = (index > this.lastIndex) ? 1 : state;
      if (state !== 0) {
        switch (state) {
          case -1:
            this._currentIndex = this.lastIndex;
            break;
          case 1:
            this._currentIndex = 0;
            break;
        }
        setTimeout(() => {
          // 如果是循環的，當動畫結束偷偷的跳到當前的index、left去
          this._renderer.removeClass(this.containerElm, 'transition');
          switch (state) {
            case -1:
              const distance = (this.lastIndex * this.elmWidth) - this.alignDistance;
              this._renderer.setStyle(this.containerElm, 'left', `${-distance}px`);
              break;
            case 1:
              this._renderer.setStyle(this.containerElm, 'left', `0px`);
              break;
          }
        }, this.aniTime);
      }
    }
  }

  private outOfBound(type) {
    switch (type) {
      case 'panleft':
        return this.currentIndex >= this.maxRightIndex;
      case 'panright':
        return this.currentIndex <= 0;
    }
  }

  private runProgress(betweenTime): Observable<any> {
    const howTimes = this.speed / betweenTime;
    const everyIncrease = 100 / this.speed * betweenTime;
    // console.log('progress');
    return interval(betweenTime).pipe(
      tap(t => {
        this.progressWidth = (t % howTimes) * everyIncrease;
      }),
      bufferCount(Math.round(this.speed / betweenTime), 0)
    );
  }

  private getAutoNum() {
    const initNum = 3;
    // 610
    const width = this.rootElm.clientWidth;
    if (width > 300) {
      return Math.floor(initNum + (width / 200));
    }
    return initNum;
  }

  private addStyle(elm: HTMLElement, style: { [key: string]: string | number }) {
    if (style) {
      Object.keys(style).forEach((key) => {
        const value = style[key];
        this._renderer.setStyle(elm, key, value);
      });
    }
  }

}
